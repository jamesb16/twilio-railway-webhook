/**
 * Greenbug Energy - GHL -> wait -> Twilio outbound call -> ElevenLabs voice -> capture result
 *
 * Endpoints:
 *   GET  /health
 *   POST /ghl/lead          (GHL webhook trigger)
 *   POST /twilio/voice      (Twilio hits for TwiML when call answers)
 *   POST /twilio/speech     (Twilio speech result after Gather)
 *   POST /twilio/status     (Twilio call status callback)
 *   GET  /tts               (Twilio <Play> fetches MP3 from here; this calls ElevenLabs)
 *
 * Env vars:
 *   PUBLIC_BASE_URL
 *   TWILIO_ACCOUNT_SID
 *   TWILIO_AUTH_TOKEN
 *   TWILIO_FROM_NUMBER
 *   ELEVENLABS_API_KEY
 *   ELEVENLABS_VOICE_ID
 */

const express = require("express");
const twilio = require("twilio");

const app = express();

// GHL usually JSON; Twilio webhooks are x-www-form-urlencoded
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));

// ---------- Health ----------
app.get("/", (req, res) => res.status(200).send("OK - Greenbug Energy outbound caller"));
app.get("/health", (req, res) => res.status(200).json({ ok: true }));

// ---------- Helpers ----------
function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function safeText(s, max = 500) {
  return String(s || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

// Very light normalizer: keep + and digits only. Twilio wants E.164.
function normalizeE164(phoneRaw) {
  if (!phoneRaw) return "";
  let p = String(phoneRaw).trim();
  p = p.replace(/[^\d+]/g, "");
  // If they submit UK format like 07..., you MUST convert in GHL or here.
  // We won't guess country codes automatically. Require +44 etc.
  return p;
}

function xmlEscape(unsafe) {
  return String(unsafe || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function baseUrl() {
  return requireEnv("PUBLIC_BASE_URL").replace(/\/+$/, "");
}

// Simple “result store” (replace with DB later)
const lastResults = new Map(); // CallSid -> {speech, confidence, ts}

// ---------- Outbound call trigger from GHL ----------
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
      body.fullName ||
      body.contact?.name ||
      body.contact?.firstName ||
      body.contact?.first_name ||
      "there";

    const to = normalizeE164(phoneRaw);
    if (!to || !to.startsWith("+")) {
      return res.status(400).json({
        ok: false,
        error: "Missing/invalid phone. Twilio requires E.164 like +447123456789",
        got: phoneRaw,
      });
    }

    const from = requireEnv("TWILIO_FROM_NUMBER");
    const accountSid = requireEnv("TWILIO_ACCOUNT_SID");
    const authToken = requireEnv("TWILIO_AUTH_TOKEN");

    // ElevenLabs required too (so you don't get silent calls)
    requireEnv("ELEVENLABS_API_KEY");
    requireEnv("ELEVENLABS_VOICE_ID");

    const client = twilio(accountSid, authToken);
    const b = baseUrl();

    // Twilio will request TwiML from this URL when the call connects
    const voiceUrl = `${b}/twilio/voice?name=${encodeURIComponent(name)}`;

    const call = await client.calls.create({
      to,
      from,
      url: voiceUrl,
      method: "POST",

      // Capture outcome
      statusCallback: `${b}/twilio/status`,
      statusCallbackMethod: "POST",
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
    });

    return res.status(200).json({
      ok: true,
      message: "Call triggered",
      sid: call.sid,
      to,
      name,
    });
  } catch (err) {
    console.error("Error in /ghl/lead:", err);
    return res.status(500).json({ ok: false, error: err.message || "Unknown error" });
  }
});

// ---------- TwiML when the call answers ----------
app.post("/twilio/voice", (req, res) => {
  const name = safeText(req.query.name || "there", 60);
  const b = baseUrl();

  // This is your “simple script” for now.
  // We’ll keep it short and natural.
  const intro = `Hi ${name}, it’s Greenbug Energy. You just requested a callback about a site survey.`;
  const question =
    `If you want to get booked in now, say "book a survey". If you’d rather, say "call me later".`;

  // We play ElevenLabs audio, then Gather speech.
  // Twilio will fetch /tts (MP3) and play it.
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${xmlEscape(`${b}/tts?text=${encodeURIComponent(intro)}`)}</Play>
  <Play>${xmlEscape(`${b}/tts?text=${encodeURIComponent(question)}`)}</Play>

  <Gather input="speech" action="${xmlEscape(`${b}/twilio/speech`)}" method="POST" speechTimeout="auto" timeout="6" />

  <Play>${xmlEscape(`${b}/tts?text=${encodeURIComponent("No worries — we’ll send you a text so you can rebook. Bye for now.")}`)}</Play>
  <Hangup/>
</Response>`;

  res.type("text/xml").send(twiml);
});

// ---------- Capture speech result ----------
app.post("/twilio/speech", (req, res) => {
  const speech = safeText((req.body.SpeechResult || "").toLowerCase(), 300);
  const confidence = req.body.Confidence;
  const callSid = req.body.CallSid;

  console.log("SpeechResult:", { callSid, speech, confidence });

  if (callSid) {
    lastResults.set(callSid, { speech, confidence, ts: new Date().toISOString() });
  }

  // Minimal intent detection (we’ll upgrade to full conversational AI next)
  let reply = "Thanks — we’ll be in touch shortly. Bye for now.";
  if (speech.includes("later") || speech.includes("not now") || speech.includes("busy")) {
    reply = "No problem — we’ll call you later. Bye for now.";
  }
  if (speech.includes("book") || speech.includes("survey") || speech.includes("appointment")) {
    reply = "Perfect — we’ll get your survey booked and text you the details. Bye for now.";
  }

  const b = baseUrl();
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${xmlEscape(`${b}/tts?text=${encodeURIComponent(reply)}`)}</Play>
  <Hangup/>
</Response>`;

  res.type("text/xml").send(twiml);
});

// ---------- Capture call status ----------
app.post("/twilio/status", (req, res) => {
  const payload = {
    CallSid: req.body.CallSid,
    CallStatus: req.body.CallStatus,
    To: req.body.To,
    From: req.body.From,
    Duration: req.body.CallDuration,
    Timestamp: req.body.Timestamp,
  };

  console.log("Call status callback:", payload);

  // You can later push this to GHL as a note / custom field update.
  // For now, we just log.
  res.status(200).send("ok");
});

// ---------- ElevenLabs TTS endpoint for Twilio <Play> ----------
app.get("/tts", async (req, res) => {
  try {
    const apiKey = requireEnv("ELEVENLABS_API_KEY");
    const voiceId = requireEnv("ELEVENLABS_VOICE_ID");

    const text = safeText(req.query.text || "", 700);
    if (!text) return res.status(400).send("Missing text");

    // ElevenLabs streaming endpoint (MP3 stream). :contentReference[oaicite:2]{index=2}
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream`;

    const elevenResp = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        // Model choice is optional; leaving it out uses ElevenLabs defaults.
        // model_id: "eleven_multilingual_v2",
        voice_settings: {
          stability: 0.45,
          similarity_boost: 0.85,
          style: 0.25,
          use_speaker_boost: true,
        },
      }),
    });

    if (!elevenResp.ok) {
      const errTxt = await elevenResp.text().catch(() => "");
      console.error("ElevenLabs error:", elevenResp.status, errTxt);
      return res.status(502).send("TTS provider error");
    }

    // Twilio will fetch this via <Play> and expects audio bytes.
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");

    // Stream response through (Node 18+)
    const reader = elevenResp.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (err) {
    console.error("Error in /tts:", err);
    res.status(500).send("TTS error");
  }
});

// ---------- (Optional) quick debug endpoint ----------
app.get("/debug/last-results", (req, res) => {
  const items = Array.from(lastResults.entries()).slice(-20);
  res.json({ ok: true, items });
});

// ---------- Listen on Railway port ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`Listening on ${PORT}`));
