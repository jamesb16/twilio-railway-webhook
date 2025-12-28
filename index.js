const express = require("express");
const twilio = require("twilio");
const axios = require("axios");
const app = express();

// Middleware to parse incoming requests
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Eleven Labs API credentials
const ELEVEN_LABS_API_KEY = 'your-eleven-labs-api-key'; // Replace with your Eleven Labs API key
const ELEVEN_LABS_VOICE_ID = 'your-voice-id'; // Replace with the cloned voice ID for Nicola

// Twilio credentials (for creating the call)
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL; // Your public URL for the app

// Endpoint to trigger outbound call from GHL webhook
app.post("/ghl/lead", async (req, res) => {
  try {
    const { name, phone, email, address, preferred_day, preferred_window, homeowner } = req.body;
    
    console.log(`Received lead: ${name}, ${phone}, ${email}, ${address}, Preferred Day: ${preferred_day}, Preferred Window: ${preferred_window}, Homeowner: ${homeowner}`);

    // Make a call using Twilio if homeowner status is "Yes"
    const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
    const call = await client.calls.create({
      to: phone,
      from: TWILIO_FROM_NUMBER,
      url: `${PUBLIC_BASE_URL}/twilio/voice?name=${encodeURIComponent(name)}&phone=${encodeURIComponent(phone)}&homeowner=${encodeURIComponent(homeowner)}&preferred_day=${encodeURIComponent(preferred_day)}&preferred_window=${encodeURIComponent(preferred_window)}`,
      method: "POST",
      statusCallback: `${PUBLIC_BASE_URL}/twilio/status`,
      statusCallbackMethod: "POST",
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"]
    });

    res.status(200).json({ status: 'success', message: 'Call triggered', sid: call.sid });
  } catch (error) {
    console.error('Error in /ghl/lead:', error);
    res.status(500).json({ error: error.message || 'Error processing lead' });
  }
});

// Endpoint to handle the Twilio call response (Voice Interaction)
app.post("/twilio/voice", async (req, res) => {
  try {
    const { name, phone, homeowner, preferred_day, preferred_window } = req.query;

    let message = `Hi ${name}, it’s Nicola from Greenbug Energy. You requested a callback about your home energy survey.`;

    // If homeowner info is provided, skip the question
    if (homeowner === "Yes") {
      message += " Thank you for confirming that you are the homeowner.";
    } else {
      message += " Can you confirm if you are the homeowner?";
    }

    // Generate voice using Eleven Labs
    const audioUrl = await sendElevenLabsMessage(message);

    // Create Twilio Voice Response
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.play(audioUrl); // Play the generated voice

    // Send response to Twilio
    res.type('text/xml');
    res.send(twiml.toString());
  } catch (error) {
    console.error('Error in /twilio/voice:', error);
    res.status(500).send('Internal Server Error');
  }
});

// Function to call Eleven Labs API to generate voice response
const sendElevenLabsMessage = async (text) => {
  try {
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

// Endpoint to capture the result of the speech input
app.post("/twilio/speech", (req, res) => {
  try {
    const speech = (req.body.SpeechResult || "").toLowerCase();
    const confidence = req.body.Confidence;

    let reply = "Sorry, I didn’t catch that. Can you repeat?";
    if (speech.includes("yes")) {
      reply = "Thank you! We will proceed with your survey booking.";
    } else if (speech.includes("no")) {
      reply = "Alright, let us know when you're ready.";
    }

    // Respond with the appropriate message
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say(reply);
    twiml.hangup();

    res.type('text/xml');
    res.send(twiml.toString());
  } catch (error) {
    console.error('Error processing speech:', error);
    res.status(500).send('Internal Server Error');
  }
});

// Endpoint for status callback (used to track call status)
app.post("/twilio/status", (req, res) => {
  try {
    const payload = {
      CallSid: req.body.CallSid,
      CallStatus: req.body.CallStatus,
      To: req.body.To,
      From: req.body.From,
      Duration: req.body.CallDuration,
      Timestamp: req.body.Timestamp,
    };

    console.log('Call status update:', payload);
    res.status(200).send('ok');
  } catch (error) {
    console.error('Error handling status callback:', error);
    res.status(500).send('Internal Server Error');
  }
});

// Health check route to confirm the server is running
app.get('/', (req, res) => {
  res.status(200).send('OK - Server is running');
});

// Start the server
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
