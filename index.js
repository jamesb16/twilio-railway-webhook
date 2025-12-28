const express = require("express");
const twilio = require("twilio");

const app = express();

// Twilio webhooks are x-www-form-urlencoded
app.use(express.urlencoded({ extended: false }));
// GHL usually sends JSON
app.use(express.json());

// -------------------- Health --------------------
app.get("/", (req, res) => res.status(200).send("OK - Greenbug Energy outbound server running"));
app.get("/health", (req, res) => res.status(200).json({ ok: true }));

// -------------------- In-memory call state --------------------
// NOTE: This is fine for MVP. If you later run multiple instances, use Redis/DB.
const callState = new Map(); // key: CallSid -> { name, phone, address, postcode, homeowner, propertyType, preferredDay, preferredWindow, intent }

function getState(callSid) {
  if (!callState.has(callSid)) callState.set(callSid, {});
  return callState.get(callSid);
}

// -------------------- Outbound call trigger from GHL --------------------
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
      body.first_name ||
      body.firstName ||
      body.contact?.firstName ||
      body.contact?.first_name ||
      body.name ||
      body.full_name ||
      body.contact?.name ||
      "there";

    if (!phoneRaw) {
      return res.status(400).json({ ok: false, error: "Missing phone in webhook payload" });
    }

    const to = String(phoneRaw).trim();
    const from = process.env.TWILIO_FROM_NUMBER;

    if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !from) {
      return res.status(500).json({
        ok: false,
        error: "Missing TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER env vars"
      });
    }

    const baseUrl = process.env.PUBLIC_BASE_URL;
    if (!baseUrl) {
      return res.status(500).json({ ok: false, error: "Missing PUBLIC_BASE_URL env var" });
    }

    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

    const call = await client.calls.create({
      to,
      from,
      url: `${baseUrl}/twilio/voice?name=${encodeURIComponent(name)}`,
      method: "POST",
      statusCallback: `${baseUrl}/twilio/status`,
      statusCallbackMethod: "POST",
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"]
    });

    return res.status(200).json({ ok: true, message: "Call triggered", sid: call.sid, to, name });
  } catch (err) {
    console.error("Error in /ghl/lead:", err);
    return res.status(500).json({ ok: false, error: err.message || "Unknown error" });
  }
});

// -------------------- ElevenLabs TTS proxy --------------------
// Twilio will <Play> this URL. You already tested /tts?text=... works.
// Requirements:
// - ELEVENLABS_API_KEY
// - ELEVENLABS_VOICE_ID
app.get("/tts", async (req, res) => {
  try {
    const text = (req.query.text || "").toString().slice(0, 600);
    if (!text) return res.status(400).send("Missing text");

    const apiKey = process.env.ELEVENLABS_API_KEY;
    const voiceId = process.env.ELEVENLABS_VOICE_ID;

    if (!apiKey || !voiceId) {
      return res.status(500).send("Missing ELEVENLABS_API_KEY or ELEVENLABS_VOICE_ID");
    }

    const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`;

    const elevenRes = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        "Accept": "audio/mpeg"
      },
      body: JSON.stringify({
        text,
        // These settings are optional; tweak later
        voice_settings: { stability: 0.4, similarity_boost: 0.85 }
      })
    });

    if (!elevenRes.ok) {
      const errText = await elevenRes.text().catch(() => "");
      console.error("ElevenLabs error:", elevenRes.status, errText);
      return res.status(500).send("ElevenLabs TTS failed");
    }

    res.setHeader("Content-Type", "audio/mpeg");
    const buf = Buffer.from(await elevenRes.arrayBuffer());
    return res.status(200).send(buf);
  } catch (e) {
    console.error("TTS error:", e);
    return res.status(500).send("TTS error");
  }
});

function ttsUrl(baseUrl, text) {
  return `${baseUrl}/tts?text=${encodeURIComponent(text)}`;
}

function twimlResponse(innerXml) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${innerXml}</Response>`;
}

// -------------------- Call entrypoint --------------------
app.post("/twilio/voice", (req, res) => {
  const baseUrl = process.env.PUBLIC_BASE_URL;
  const name = (req.query.name || "there").toString();

  const intro =
    `Hi ${name}, it’s Nicola from Greenbug Energy. ` +
    `You’ve just requested a free home energy survey for solar panels. ` +
    `Have I caught you at an okay time?`;

  const xml = twimlResponse(`
    <Play>${ttsUrl(baseUrl, intro)}</Play>
    <Gather input="speech" action="/twilio/step?step=0" method="POST" speechTimeout="auto" />
    <Play>${ttsUrl(baseUrl, "No worries at all. I’ll send you a text and we can arrange a better time. Bye for now.")}</Play>
    <Hangup/>
  `);

  res.type("text/xml").send(xml);
});

// -------------------- Conversation steps --------------------
app.post("/twilio/step", async (req, res) => {
  const baseUrl = process.env.PUBLIC_BASE_URL;
  const step = String(req.query.step || "");
  const callSid = req.body.CallSid;
  const speech = (req.body.SpeechResult || "").toLowerCase();

  const state = getState(callSid);

  // Helper: quick yes/no detection
  const isYes = (s) => /\b(yes|yeah|yep|okay|ok|sure|fine|go ahead)\b/.test(s);
  const isNo = (s) => /\b(no|nope|not|later|busy|can't|cannot)\b/.test(s);

  // STEP 0: "Is now ok?"
  if (step === "0") {
    if (isNo(speech)) {
      const xml = twimlResponse(`
        <Play>${ttsUrl(baseUrl, "No problem. I’ll send you a quick text and you can pick a time that suits. Bye for now.")}</Play>
        <Hangup/>
      `);
      return res.type("text/xml").send(xml);
    }

    const q1 =
      `Great. Just to make sure I’m speaking to the right person — ` +
      `can I take your postcode, please?`;

    const xml = twimlResponse(`
      <Play>${ttsUrl(baseUrl, q1)}</Play>
      <Gather input="speech" action="/twilio/step?step=1" method="POST" speechTimeout="auto" />
      <Play>${ttsUrl(baseUrl, "Sorry, I didn’t catch that. I’ll send you a text to confirm details. Bye for now.")}</Play>
      <Hangup/>
    `);
    return res.type("text/xml").send(xml);
  }

  // STEP 1: postcode
  if (step === "1") {
    state.postcode = (req.body.SpeechResult || "").trim();

    const q2 =
      `Thanks. And are you the homeowner at that address?`;

    const xml = twimlResponse(`
      <Play>${ttsUrl(baseUrl, q2)}</Play>
      <Gather input="speech" action="/twilio/step?step=2" method="POST" speechTimeout="auto" />
      <Play>${ttsUrl(baseUrl, "No worries. I’ll send you a text and we can confirm it there. Bye for now.")}</Play>
      <Hangup/>
    `);
    return res.type("text/xml").send(xml);
  }

  // STEP 2: homeowner yes/no
  if (step === "2") {
    state.homeowner = isYes(speech) ? "yes" : isNo(speech) ? "no" : "unknown";

    const q3 =
      `Perfect. And what type of property is it — is it a house, bungalow, or a flat?`;

    const xml = twimlResponse(`
      <Play>${ttsUrl(baseUrl, q3)}</Play>
      <Gather input="speech" action="/twilio/step?step=3" method="POST" speechTimeout="auto" />
      <Play>${ttsUrl(baseUrl, "That’s okay. I’ll send you a text to confirm a couple of details. Bye for now.")}</Play>
      <Hangup/>
    `);
    return res.type("text/xml").send(xml);
  }

  // STEP 3: property type
  if (step === "3") {
    state.propertyType = (req.body.SpeechResult || "").trim();

    const q4 =
      `Lovely. And just so I aim this correctly — are you mainly looking at solar panels to cut bills, or also battery storage?`;

    const xml = twimlResponse(`
      <Play>${ttsUrl(baseUrl, q4)}</Play>
      <Gather input="speech" action="/twilio/step?step=4" method="POST" speechTimeout="auto" />
      <Play>${ttsUrl(baseUrl, "No worries. I’ll send you a text and we can take it from there. Bye for now.")}</Play>
      <Hangup/>
    `);
    return res.type("text/xml").send(xml);
  }

  // STEP 4: intent + move to booking preference
  if (step === "4") {
    state.intent = (req.body.SpeechResult || "").trim();

    const q5 =
      `Great. I can get a free home survey booked in. ` +
      `What suits you better — morning or afternoon?`;

    const xml = twimlResponse(`
      <Play>${ttsUrl(baseUrl, q5)}</Play>
      <Gather input="speech" action="/twilio/step?step=5" method="POST" speechTimeout="auto" />
      <Play>${ttsUrl(baseUrl, "No worries. I’ll send you a text and you can reply with what suits. Bye for now.")}</Play>
      <Hangup/>
    `);
    return res.type("text/xml").send(xml);
  }

  // STEP 5: morning/afternoon
  if (step === "5") {
    state.preferredWindow = speech.includes("after") ? "afternoon" : speech.includes("morn") ? "morning" : "unknown";

    const q6 =
      `Perfect. And which day works best — is it during the week, or Saturday?`;

    const xml = twimlResponse(`
      <Play>${ttsUrl(baseUrl, q6)}</Play>
      <Gather input="speech" action="/twilio/step?step=6" method="POST" speechTimeout="auto" />
      <Play>${ttsUrl(baseUrl, "No worries. I’ll text you and we can lock in a day. Bye for now.")}</Play>
      <Hangup/>
    `);
    return res.type("text/xml").send(xml);
  }

  // STEP 6: preferred day + send to GHL inbound webhook
  if (step === "6") {
    state.preferredDay = (req.body.SpeechResult || "").trim();

    const ghlUrl = process.env.GHL_BOOKING_TRIGGER_URL;
    if (!ghlUrl) {
      console.error("Missing GHL_BOOKING_TRIGGER_URL");
    } else {
      // Build payload that becomes your mapping reference in GHL
      const payload = {
        source: "AI_CALL",
        agent: "Nicola",
        product: "Solar Panels",
        call: {
          callSid: req.body.CallSid,
          from: req.body.From,
          to: req.body.To
        },
        lead: {
          phone: req.body.To, // Lead phone number we dialed
          postcode: state.postcode || "",
          homeowner: state.homeowner || "",
          propertyType: state.propertyType || "",
          interest: state.intent || ""
        },
        booking: {
          preferred_day: state.preferredDay || "",
          preferred_window: state.preferredWindow || "",
          notes: "Booked via AI call (Nicola)."
        },
        transcript: {
          last_step_speech: (req.body.SpeechResult || "").trim()
        }
      };

      try {
        const r = await fetch(ghlUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        const txt = await r.text().catch(() => "");
        console.log("Posted to GHL webhook:", r.status, txt.slice(0, 300));
      } catch (e) {
        console.error("Error posting to GHL webhook:", e);
      }
    }

    const closing =
      `Lovely. I’ll get that booked in now and I’ll text you the details. ` +
      `If anything changes, just reply to the text. Thanks — bye!`;

    const xml = twimlResponse(`
      <Play>${ttsUrl(baseUrl, closing)}</Play>
      <Hangup/>
    `);

    // Clean up
    callState.delete(callSid);

    return res.type("text/xml").send(xml);
  }

  // Fallback
  const xml = twimlResponse(`
    <Play>${ttsUrl(baseUrl, "Sorry, something went wrong there. I’ll send you a text to arrange the survey. Bye for now.")}</Play>
    <Hangup/>
  `);
  return res.type("text/xml").send(xml);
});

// -------------------- Call status --------------------
app.post("/twilio/status", (req, res) => {
  const payload = {
    CallSid: req.body.CallSid,
    CallStatus: req.body.CallStatus,
    To: req.body.To,
    From: req.body.From,
    Duration: req.body.CallDuration,
    Timestamp: req.body.Timestamp
  };
  console.log("Call status callback:", payload);
  res.status(200).send("ok");
});

// -------------------- Start server --------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`Listening on ${PORT}`));
