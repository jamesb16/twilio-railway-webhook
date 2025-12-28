const express = require('express');
const twilio = require('twilio');
const axios = require('axios');
const app = express();

// GHL often sends JSON; Twilio webhooks are x-www-form-urlencoded
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

// -------------------- In-memory call sessions (simple + effective) --------------------
const sessions = new Map();

// Eleven Labs API credentials
const ELEVEN_LABS_API_KEY = 'your-eleven-labs-api-key'; // Replace with your Eleven Labs API key
const ELEVEN_LABS_VOICE_ID = 'your-voice-id'; // Replace with the cloned voice ID for Nicola

// -------------------- Health --------------------
app.get('/', (req, res) => res.status(200).send('OK - Greenbug outbound AI is running'));
app.get('/health', (req, res) => res.status(200).json({ ok: true }));

// -------------------- Trigger outbound call from GHL --------------------
app.post('/ghl/lead', async (req, res) => {
  try {
    const body = req.body || {};
    const phoneRaw = body.phone || body.Phone || body.contact?.phone;
    const name = body.name || body.contact?.name || "there";
    const email = body.email || body.contact?.email || "";
    const address = body.address || body.contact?.address1 || "";
    const postcode = body.postcode || body.contact?.postalCode || "";
    const propertyType = body.propertyType || body.contact?.propertyType || "";
    const isHomeowner = body.isHomeowner || body.contact?.isHomeowner || ""; // Homeowner status

    if (!phoneRaw) {
      return res.status(400).json({ ok: false, error: 'Missing phone in webhook payload' });
    }

    const to = String(phoneRaw).trim();
    const from = process.env.TWILIO_FROM_NUMBER;

    if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !from) {
      return res.status(500).json({
        ok: false,
        error: 'Missing TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER env vars',
      });
    }

    const baseUrl = process.env.PUBLIC_BASE_URL;
    if (!baseUrl) {
      return res.status(500).json({ ok: false, error: 'Missing PUBLIC_BASE_URL env var (your Railway public URL)' });
    }

    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

    // Trigger the call – Twilio will hit /twilio/voice for TwiML
    const call = await client.calls.create({
      to,
      from,
      url: `${baseUrl}/twilio/voice?name=${encodeURIComponent(name)}&phone=${encodeURIComponent(to)}&email=${encodeURIComponent(email)}&address=${encodeURIComponent(address)}&postcode=${encodeURIComponent(postcode)}&propertyType=${encodeURIComponent(propertyType)}&isHomeowner=${encodeURIComponent(isHomeowner)}`,
      method: 'POST',
      statusCallback: `${baseUrl}/twilio/status`,
      statusCallbackMethod: 'POST',
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
    });

    return res.status(200).json({
      ok: true,
      message: 'Call triggered',
      sid: call.sid,
      to,
      name,
    });
  } catch (err) {
    console.error('Error in /ghl/lead:', err);
    return res.status(500).json({ ok: false, error: err.message || 'Unknown error' });
  }
});

// -------------------- Twilio: first prompt (TwiML) --------------------
app.post('/twilio/voice', async (req, res) => {
  try {
    const baseUrl = process.env.PUBLIC_BASE_URL;
    const { name, phone, homeowner, preferred_day, preferred_window } = req.query;

    // If the homeowner information is already provided, skip asking
    let openingMessage = `Hi ${name}, it’s Nicola from Greenbug Energy. You requested a callback about your home energy survey.`;

    // Skip the "Are you the homeowner?" question if it's already answered
    if (homeowner === 'Yes') {
      openingMessage += ' Thanks for confirming your homeownership.';
    } else {
      openingMessage += ' Can you confirm if you are the homeowner?';
    }

    // Generate voice message using Eleven Labs API
    const audioUrl = await sendElevenLabsMessage(openingMessage);

    // Create Twilio VoiceResponse
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.play(audioUrl); // Play the generated voice

    // Send the TwiML response
    res.type('text/xml');
    res.send(twiml.toString());
  } catch (error) {
    console.error('Error in /twilio/voice:', error);
    res.status(500).send('Internal Server Error');
  }
});

// -------------------- Send message to Eleven Labs for TTS --------------------
const sendElevenLabsMessage = async (text) => {
  try {
    const response = await axios.post('https://api.elevenlabs.io/v1/text-to-speech', {
      voice_id: ELEVEN_LABS_VOICE_ID,
      text: text,
      voice_settings: { speed: 1.0, pitch: 1.0 }, // Adjust the voice settings if needed
    }, {
      headers: {
        'Authorization': `Bearer ${ELEVEN_LABS_API_KEY}`,
        'Content-Type': 'application/json',
      },
    });

    console.log('Eleven Labs voice response:', response.data);
    return response.data.audio_url; // This will be the URL of the generated audio file
  } catch (error) {
    console.error('Error generating voice message from Eleven Labs:', error);
    throw new Error('Failed to generate voice message');
  }
};

// -------------------- Twilio: handle speech + continue conversation --------------------
app.post('/twilio/speech', async (req, res) => {
  try {
    const { CallSid, SpeechResult } = req.body;
    const speech = (SpeechResult || '').trim();

    const session = sessions.get(CallSid) || { lead: {}, transcript: [], turns: 0 };
    session.turns = (session.turns || 0) + 1;

    // Add user speech to transcript
    if (speech) session.transcript.push({ role: 'user', text: speech });

    console.log('Speech:', { CallSid, speech });

    // Simple flow to handle responses like Yes, No, etc.
    let reply = "Sorry, I didn’t catch that. Can you repeat?";
    if (speech.includes('yes')) {
      reply = "Thank you! We'll proceed with the survey.";
    } else if (speech.includes('no')) {
      reply = "Alright, let us know when you're ready for the survey.";
    }

    // Generate Twilio response
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say(reply);
    twiml.hangup(); // End the call

    res.type('text/xml');
    res.send(twiml.toString());
  } catch (error) {
    console.error('Error processing speech:', error);
    res.status(500).send('Internal Server Error');
  }
});

// -------------------- Call status callback --------------------
app.post('/twilio/status', (req, res) => {
  const payload = {
    CallSid: req.body.CallSid,
    CallStatus: req.body.CallStatus,
    To: req.body.To,
    From: req.body.From,
    Duration: req.body.CallDuration,
    Timestamp: req.body.Timestamp,
  };

  console.log('Call status:', payload);

  // Cleanup finished calls
  if (payload.CallStatus === 'completed') {
    sessions.delete(payload.CallSid);
  }

  res.status(200).send('ok');
});

// -------------------- Health Check --------------------
app.get('/', (req, res) => {
  res.status(200).send('OK - Server is running');
});

// Start the server
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
