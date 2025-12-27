const express = require("express");
const twilio = require("twilio");
const fetch = require("node-fetch");

const app = express();

// Twilio + GHL payload handling
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ---------- Health ----------
app.get("/", (req, res) =>
  res.status(200).send("OK - Greenbug AI Call Server Running")
);
app.get("/health", (req, res) => res.status(200).json({ ok: true }));

// ---------- GHL → Trigger outbound call ----------
app.post("/ghl/lead", async (req, res) => {
  try {
    const body = req.body || {};

    const phone =
      body.phone ||
      body.Phone ||
      body.contact?.phone ||
      body.contact?.phoneNumber;

    const firstName =
      body.first_name ||
      body.firstName ||
      body.contact?.firstName ||
      "there";

    if (!phone) {
      return res.status(400).json({ ok: false, error: "Missing phone" });
    }

    const client = twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );

    const call = await client.calls.create({
      to: phone,
      from: process.env.TWILIO_FROM_NUMBER,
      url: `${process.env.PUBLIC_BASE_URL}/twilio/voice?name=${encodeURIComponent(
        firstName
      )}`,
      method: "POST",
      statusCallback: `${process.env.PUBLIC_BASE_URL}/twilio/status`,
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
      statusCallbackMethod: "POST",
    });

    return res.json({ ok: true, sid: call.sid });
  } catch (err) {
    console.error("GHL lead error:", err);
    res.status(500).json({ ok: false });
  }
});

// ---------- What Nicola says when call connects ----------
app.post("/twilio/voice", (req, res) => {
  const name = req.query.name || "there";

  const twiml = `
<Response>
  <Play>${process.env.PUBLIC_BASE_URL}/tts?text=${encodeURIComponent(
    `Hi ${name}, it’s Nicola from Greenbug Energy. You recently requested a free solar survey. Is now a good time to talk?`
  )}</Play>

  <Gather input="speech" action="/twilio/speech" method="POST" speechTimeout="auto" />

  <Play>${process.env.PUBLIC_BASE_URL}/tts?text=${encodeURIComponent(
    "No worries, we’ll send you a text instead. Speak soon."
  )}</Play>
</Response>
  `;

  res.type("text/xml").send(twiml);
});

// ---------- Conversational loop + booking ----------
app.post("/twilio/speech", async (req, res) => {
  const speech = (req.body.SpeechResult || "").toLowerCase();
  const from = req.body.From;

  let reply =
    "Thanks for your time. We’ll send you a message with the next steps.";

  // Booking intent
  if (
    speech.includes("yes") ||
    speech.includes("book") ||
    speech.includes("okay") ||
    speech.includes("fine")
  ) {
    // 🔥 BOOK INTO GHL 🔥
    await fetch(process.env.GHL_BOOKING_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        phone: from,
        booking_intent: "solar_survey",
        agent: "Nicola",
        source: "AI_CALL",
      }),
    });

    reply =
      "Perfect. I’ve got that booked in now. You’ll receive a text shortly with all the details.";
  }

  const twiml = `
<Response>
  <Play>${process.env.PUBLIC_BASE_URL}/tts?text=${encodeURIComponent(reply)}</Play>
  <Hangup/>
</Response>
  `;

  res.type("text/xml").send(twiml);
});

// ---------- Call status ----------
app.post("/twilio/status", (req, res) => {
  console.log("Call status:", req.body.CallStatus);
  res.send("ok");
});

// ---------- ElevenLabs TTS endpoint ----------
app.get("/tts", async (req, res) => {
  const text = req.query.text || "Hello from Greenbug Energy";

  const elevenRes = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${process.env.ELEVENLABS_VOICE_ID}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": process.env.ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
        voice_settings: {
          stability: 0.35,
          similarity_boost: 0.75,
        },
      }),
    }
  );

  const audio = await elevenRes.arrayBuffer();
  res.set("Content-Type", "audio/mpeg");
  res.send(Buffer.from(audio));
});

// ---------- Start ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () =>
  console.log(`Greenbug AI running on ${PORT}`)
);
