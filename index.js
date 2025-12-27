/**
 * Greenbug Energy
 * GHL -> wait -> Twilio outbound call -> ElevenLabs cloned voice (Nicola)
 */

const express = require("express");
const twilio = require("twilio");

const app = express();

// GHL sends JSON, Twilio sends form-encoded
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));

/* =======================
   CONFIG / HELPERS
======================= */

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function baseUrl() {
  return requireEnv("PUBLIC_BASE_URL").replace(/\/+$/, "");
}

function xmlEscape(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function cleanText(str, max = 700) {
  return String(str || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function normalizeE164(phone) {
  if (!phone) return "";
  return String(phone).replace(/[^\d+]/g, "");
}

/* =======================
   HEALTH
======================= */

app.get("/", (req, res) => {
  res.send("OK – Greenbug Energy outbound caller running");
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

/* =======================
   GHL → TRIGGER OUTBOUND CALL
======================= */

app.post("/ghl/lead", async (req, res) => {
  try {
    const body = req.body || {};

    const phoneRaw =
      body.phone ||
      body.Phone ||
      body.contact?.phone ||
      body.contact?.phoneNumber ||
      body.contact?.phone_number;

    const name =
      body.name ||
      body.full_name ||
      body.contact?.firstName ||
      body.contact?.name ||
      "there";

    const to = normalizeE164(phoneRaw);
    if (!to.startsWith("+")) {
      return res.status(400).json({
        ok: false,
        error: "Phone must be E.164 format (+44...)",
        got: phoneRaw,
      });
    }

    const client = twilio(
      requireEnv("TWILIO_ACCOUNT_SID"),
      requireEnv("TWILIO_AUTH_TOKEN")
    );

    const call = await client.calls.create({
      to,
      from: requireEnv("TWILIO_FROM_NUMBER"),
      url: `${baseUrl()}/twilio/voice?name=${encodeURIComponent(name)}`,
      method: "POST",
      statusCallback: `${baseUrl()}/twilio/status`,
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
      statusCallbackMethod: "POST",
    });

    res.json({
      ok: true,
      message: "Call triggered",
      sid: call.sid,
    });
  } catch (err) {
    console.error("GHL ERROR:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* =======================
   TWILIO – CALL SCRIPT
======================= */

app.post("/twilio/voice", (req, res) => {
  const leadName = cleanText(req.query.name || "there", 50);
  const agent = process.env.AGENT_NAME || "Nicola";
  const b = baseUrl();

  const intro = `Hi ${leadName}, I’m ${agent} from Greenbug Energy. You recently requested a callback about a site survey.`;
  const question =
    `If now’s a good time, just say book a survey. Otherwise, say call me later.`;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${xmlEscape(`${b}/tts?text=${encodeURIComponent(intro)}`)}</Play>
  <Play>${xmlEscape(`${b}/tts?text=${encodeURIComponent(question)}`)}</Play>

  <Gather
    input="speech"
    action="${xmlEscape(`${b}/twilio/speech`)}"
    method="POST"
    timeout="6"
    speechTimeout="auto"
  />

  <Play>${xmlEscape(`${b}/tts?text=${encodeURIComponent(
    "No problem at all. We’ll send you a text so you can rebook at a better time. Bye for now."
  )}`)}</Play>
  <Hangup/>
</Response>`;

  res.type("text/xml").send(twiml);
});

/* =======================
   TWILIO – SPEECH RESULT
======================= */

app.post("/twilio/speech", (req, res) => {
  const speech = cleanText((req.body.SpeechResult || "").toLowerCase(), 300);
  const b = baseUrl();

  let reply =
    "Thanks so much. We’ll be in touch shortly. Bye for now.";

  if (speech.includes("later") || speech.includes("busy")) {
    reply = "No problem at all. We’ll give you a call later. Bye for now.";
  }

  if (speech.includes("book") || speech.includes("survey")) {
    reply =
      "Perfect. We’ll get your site survey booked in and text you the details shortly. Bye for now.";
  }

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${xmlEscape(`${b}/tts?text=${encodeURIComponent(reply)}`)}</Play>
  <Hangup/>
</Response>`;

  res.type("text/xml").send(twiml);
});

/* =======================
   TWILIO – STATUS CALLBACK
======================= */

app.post("/twilio/status", (req, res) => {
  console.log("CALL STATUS:", {
    sid: req.body.CallSid,
    status: req.body.CallStatus,
    to: req.body.To,
    duration: req.body.CallDuration,
  });
  res.send("ok");
});

/* =======================
   ELEVENLABS TTS ENDPOINT
======================= */

app.get("/tts", async (req, res) => {
  try {
    const text = cleanText(req.query.text, 700);
    if (!text) return res.status(400).send("Missing text");

    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${requireEnv(
        "ELEVENLABS_VOICE_ID"
      )}/stream`,
      {
        method: "POST",
        headers: {
          "xi-api-key": requireEnv("ELEVENLABS_API_KEY"),
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text,
          voice_settings: {
            stability: 0.45,
            similarity_boost: 0.85,
            style: 0.3,
            use_speaker_boost: true,
          },
        }),
      }
    );

    if (!response.ok) {
      const err = await response.text();
      console.error("ELEVENLABS ERROR:", err);
      return res.status(502).send("TTS failed");
    }

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");

    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (err) {
    console.error("TTS ERROR:", err);
    res.status(500).send("TTS error");
  }
});

/* =======================
   START SERVER
======================= */

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () =>
  console.log(`Greenbug Energy caller listening on ${PORT}`)
);
