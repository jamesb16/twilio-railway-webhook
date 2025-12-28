const express = require('express');
const twilio = require('twilio');
const axios = require('axios');
const app = express();

// GHL often sends JSON; Twilio webhooks are x-www-form-urlencoded
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

// Eleven Labs API credentials
const ELEVEN_LABS_API_KEY = 'your-eleven-labs-api-key'; // Replace with your Eleven Labs API key
const ELEVEN_LABS_VOICE_ID = 'your-voice-id'; // Replace with the cloned voice ID for Nicola

// -------------------- Health --------------------
app.get('/', (req, res) => res.status(200).send('OK - Greenbug outbound AI is running'));
app.get('/health', (req, res) => res.status(200).json({ ok: true }));

// -------------------- Trigger outbound call from GHL --------------------
app.post('/ghl/lead', async (req, res) => {
  try {
    const { name, phone, email, address, preferred_day, preferred_window, homeowner } = req.body;

    console.log(`Received lead: ${name}, ${phone}, ${email}, ${address}, Preferred Day: ${preferred_day}, Preferred Window: ${preferred_window}, Homeowner: ${homeowner}`);

    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    
    // Check environment variables
    console.log("Twilio Environment Variables:", process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN, process.env.TWILIO_FROM_NUMBER);

    const call = await client.calls.create({
      to: phone,
      from: process.env.TWILIO_FROM_NUMBER,
      url: `${process.env.PUBLIC_BASE_URL}/twilio/voice?name=${encodeURIComponent(name)}&phone=${encodeURIComponent(phone)}&homeowner=${encodeURIComponent(homeowner)}&preferred_day=${encodeURIComponent(preferred_day)}&preferred_window=${encodeURIComponent(preferred_window)}`,
      method: 'POST',
      statusCallback: `${process.env.PUBLIC_BASE_URL}/twilio/status`,
      statusCallbackMethod: 'POST',
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
    });

    res.status(200).json({ status: 'success', message: 'Call triggered', sid: call.sid });
  } catch (error) {
    console.error('Error in /ghl/lead:', error);
    res.status(500).json({ error: error.message || 'Error processing lead' });
  }
});

// -------------------- Twilio: first prompt (TwiML) --------------------
app.post('/twilio/voice', async (req, res) => {
  try {
    const { name, phone, homeowner, preferred_day, preferred_window } = req.query;

    console.log(`Received voice request: Name: ${name}, Phone: ${phone}, Homeowner: ${homeowner}`);

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
    console.log(`Sending message to Eleven Labs: ${text}`);
    const response = await axios.post('https://api.elevenlabs.io/v1/text-to-speech', {
      voice_id: ELEVEN_LABS_VOICE_ID,
      text: text,
      voice_settings: { speed: 1.0, pitch: 1.0 },
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

    let reply = "Sorry, I didn’t catch that. Can you repeat?";
    if (speech.includes('yes')) {
      reply = "Thank you! We'll proceed with the survey.";
    } else if (speech.includes('no')) {
      reply = "Alright, let us know when you're ready for the survey.";
    }

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
