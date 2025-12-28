const express = require("express");
const twilio = require("twilio");

const app = express();

// GHL often sends JSON; Twilio webhooks are x-www-form-urlencoded
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));

// -------------------- In-memory call sessions --------------------
/**
 * sessions[CallSid] = {
 *   lead: { name, phone, email, address, postcode, propertyType, isHomeowner },
 *   transcript: [{ role: "assistant"|"user", text }],
 *   turns: number,
 *   pending_user_utterance: string
 * }
 */
const sessions = new Map();

// -------------------- Simple TTS cache (cuts “filler” latency hard) --------------------
const ttsCache = new Map(); // key=text -> Buffer(audio)

// -------------------- Helpers --------------------
function normalizeYesNo(value) {
  if (value === undefined || value === null) return "";
  const v = String(value).trim().toLowerCase();
  if (!v) return "";
  if (["yes", "y", "true", "1"].includes(v)) return "Yes";
  if (["no", "n", "false", "0"].includes(v)) return "No";
  // sometimes GHL sends "Yes " or "YES" etc
  if (v.includes("yes")) return "Yes";
  if (v.includes("no")) return "No";
  return String(value).trim();
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// A few “natural” fillers to mask the response gap
const FILLERS = [
  "Mm-hm — just a sec.",
  "Okay… one moment.",
  "Got you. Just checking that now.",
  "No worries — bear with me a second.",
  "Okay — system’s being a bit slow right now.",
  "Alright, give me two seconds."
];

// -------------------- Health --------------------
app.get("/", (req, res) => res.status(200).send("OK - Greenbug outbound AI is running"));
app.get("/health", (req, res) => res.status(200).json({ ok: true }));

// -------------------- Trigger outbound call from GHL --------------------
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
      [body.contact?.firstName, body.contact?.lastName].filter(Boolean).join(" ") ||
      body.contact?.first_name ||
      "there";

    const email =
      body.email ||
      body.Email ||
      body.contact?.email ||
      body.contact?.emailAddress ||
      "";

    const address =
      body.address ||
      body.Address ||
      body.contact?.address1 ||
      body.contact?.address ||
      "";

    const postcode =
      body.postcode ||
      body.postCode ||
      body.Postcode ||
      body.contact?.postalCode ||
      body.contact?.postcode ||
      "";

    const propertyType =
      body.propertyType ||
      body["Property Type"] ||
      body.contact?.propertyType ||
      "";

    // IMPORTANT: normalise homeowner so the AI can trust it
    const isHomeownerRaw =
      body.isHomeowner ||
      body["Are You The Homeowner"] ||
      body.contact?.isHomeowner ||
      "";

    const isHomeowner = normalizeYesNo(isHomeownerRaw);

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
      return res.status(500).json({
        ok: false,
        error: "Missing PUBLIC_BASE_URL env var (your Railway public URL)"
      });
    }

    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

    const call = await client.calls.create({
      to,
      from,
      url: `${baseUrl}/twilio/voice?name=${encodeURIComponent(name)}&phone=${encodeURIComponent(
        to
      )}&email=${encodeURIComponent(email)}&address=${encodeURIComponent(
        address
      )}&postcode=${encodeURIComponent(postcode)}&propertyType=${encodeURIComponent(
        propertyType
      )}&isHomeowner=${encodeURIComponent(isHomeowner)}`,
      method: "POST",
      statusCallback: `${baseUrl}/twilio/status`,
      statusCallbackMethod: "POST",
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"]
    });

    return res.status(200).json({
      ok: true,
      message: "Call triggered",
      sid: call.sid,
      to,
      name
    });
  } catch (err) {
    console.error("Error in /ghl/lead:", err);
    return res.status(500).json({ ok: false, error: err.message || "Unknown error" });
  }
});

// -------------------- Twilio: first prompt (TwiML) --------------------
app.post("/twilio/voice", async (req, res) => {
  const baseUrl = process.env.PUBLIC_BASE_URL;

  const name = (req.query.name || "there").toString();
  const phone = (req.query.phone || "").toString();
  const email = (req.query.email || "").toString();
  const address = (req.query.address || "").toString();
  const postcode = (req.query.postcode || "").toString();
  const propertyType = (req.query.propertyType || "").toString();
  const isHomeowner = normalizeYesNo((req.query.isHomeowner || "").toString());

  const callSid = req.body.CallSid || req.query.CallSid || "";

  sessions.set(callSid, {
    lead: { name, phone, email, address, postcode, propertyType, isHomeowner },
    transcript: [{ role: "assistant", text: "Call started." }],
    turns: 0,
    pending_user_utterance: ""
  });

  const opening = `Hi ${name}. It’s Nicola from Greenbug Energy. You just requested a free home energy survey about solar panels — have I caught you at an okay time?`;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${baseUrl}/tts?text=${encodeURIComponent(opening)}</Play>
  <Gather input="speech" language="en-GB" action="${baseUrl}/twilio/speech" method="POST" speechTimeout="auto" timeout="6"/>
  <Play>${baseUrl}/tts?text=${encodeURIComponent("No worries — I’ll send you a text and you can pick a time that suits. Bye for now.")}</Play>
  <Hangup/>
</Response>`;

  res.type("text/xml").send(twiml);
});

// -------------------- Twilio: handle speech (FAST) --------------------
// We do NOT call OpenAI here. We reply immediately with a filler + redirect.
// This dramatically reduces the “gap” feeling.
app.post("/twilio/speech", async (req, res) => {
  const baseUrl = process.env.PUBLIC_BASE_URL;
  const callSid = req.body.CallSid;
  const speech = (req.body.SpeechResult || "").trim();

  const session = sessions.get(callSid) || { lead: {}, transcript: [], turns: 0, pending_user_utterance: "" };
  session.turns = (session.turns || 0) + 1;

  if (speech) session.transcript.push({ role: "user", text: speech });
  session.pending_user_utterance = speech;

  sessions.set(callSid, session);

  // Safety stop
  if (session.turns >= 10) {
    const bye = "Thanks for that — I’ll send you a quick text and we can take it from there. Bye for now.";
    const twimlEnd = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${baseUrl}/tts?text=${encodeURIComponent(bye)}</Play>
  <Hangup/>
</Response>`;
    return res.type("text/xml").send(twimlEnd);
  }

  const filler = pickRandom(FILLERS);

  // Play filler, then redirect to /twilio/next where we generate the real reply
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${baseUrl}/tts?text=${encodeURIComponent(filler)}</Play>
  <Redirect method="POST">${baseUrl}/twilio/next</Redirect>
</Response>`;

  return res.type("text/xml").send(twiml);
});

// -------------------- Twilio: next step (SLOW) --------------------
// This is where we call OpenAI and decide what to say next.
app.post("/twilio/next", async (req, res) => {
  const baseUrl = process.env.PUBLIC_BASE_URL;
  const callSid = req.body.CallSid || req.query.CallSid;

  const session = sessions.get(callSid);
  if (!session) {
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${baseUrl}/tts?text=${encodeURIComponent("Sorry — something glitched on my side. I’ll send you a text instead.")}</Play>
  <Hangup/>
</Response>`;
    return res.type("text/xml").send(twiml);
  }

  // Get AI reply + intent
  let ai;
  try {
    ai = await getAiTurn({
      lead: session.lead,
      transcript: session.transcript
    });
  } catch (e) {
    console.error("getAiTurn failed:", e);
    ai = {
      reply: fallbackNextQuestion(session.lead),
      intent: "CONTINUE",
      end_state: "CONTINUE",
      booking: {}
    };
  }

  session.transcript.push({ role: "assistant", text: ai.reply });

  if (ai.intent === "BOOK") {
    try {
      await postToGhlBookingWebhook({
        lead: session.lead,
        booking: ai.booking || {},
        transcript: session.transcript
      });
    } catch (e) {
      console.error("GHL webhook post failed:", e?.message || e);
    }
  }

  sessions.set(callSid, session);

  const shouldHangup = ["BOOKED_DONE", "NOT_INTERESTED", "LATER_DONE"].includes(ai.end_state);

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${baseUrl}/tts?text=${encodeURIComponent(ai.reply)}</Play>
  ${
    shouldHangup
      ? "<Hangup/>"
      : `<Gather input="speech" language="en-GB" action="${baseUrl}/twilio/speech" method="POST" speechTimeout="auto" timeout="7"/>`
  }
  ${
    shouldHangup
      ? ""
      : `<Play>${baseUrl}/tts?text=${encodeURIComponent("Sorry — I didn’t catch that. Can you say that one more time?")}</Play>`
  }
</Response>`;

  return res.type("text/xml").send(twiml);
});

// If OpenAI gives non-JSON, we ask something sensible WITHOUT looping homeowner if already known
function fallbackNextQuestion(lead) {
  const homeowner = normalizeYesNo(lead?.isHomeowner || "");
  if (!lead?.postcode && lead?.address) return "Perfect — what’s the postcode for that address?";
  if (!lead?.address) return "Quick one — what’s the full address for the property you want the survey on?";
  if (homeowner === "Yes") return "Lovely — and is the roof mostly clear, or is there much shade from trees or nearby buildings?";
  if (homeowner === "No") return "No worries — are you the tenant or are you enquiring on someone’s behalf?";
  return "Perfect — and is this for a house or a flat?";
}

// -------------------- ElevenLabs TTS endpoint (Twilio plays this) --------------------
app.get("/tts", async (req, res) => {
  try {
    const text = String(req.query.text || "").trim();
    if (!text) return res.status(400).send("Missing text");

    // Cache hit = very fast
    if (ttsCache.has(text)) {
      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).send(ttsCache.get(text));
    }

    if (!process.env.ELEVENLABS_API_KEY || !process.env.ELEVENLABS_VOICE_ID) {
      return res.status(500).send("Missing ELEVENLABS_API_KEY or ELEVENLABS_VOICE_ID");
    }

    const safeText = text.slice(0, 600);
    const voiceId = process.env.ELEVENLABS_VOICE_ID;

    // Correct ElevenLabs endpoint:
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;

    const r = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": process.env.ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
        Accept: "audio/mpeg"
      },
      body: JSON.stringify({
        text: safeText,
        model_id: "eleven_multilingual_v2",
        voice_settings: {
          stability: 0.4,
          similarity_boost: 0.85
        }
      })
    });

    if (!r.ok) {
      const errText = await r.text().catch(() => "");
      console.error("ElevenLabs error:", r.status, errText);
      return res.status(500).send("TTS failed");
    }

    const audio = Buffer.from(await r.arrayBuffer());
    ttsCache.set(text, audio); // store exact text audio
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).send(audio);
  } catch (e) {
    console.error("TTS error:", e);
    return res.status(500).send("TTS crashed");
  }
});

// -------------------- Call status callback --------------------
app.post("/twilio/status", (req, res) => {
  const payload = {
    CallSid: req.body.CallSid,
    CallStatus: req.body.CallStatus,
    To: req.body.To,
    From: req.body.From,
    Duration: req.body.CallDuration,
    Timestamp: req.body.Timestamp
  };

  console.log("Call status:", payload);

  if (payload.CallStatus === "completed") {
    sessions.delete(payload.CallSid);
  }

  res.status(200).send("ok");
});

// -------------------- AI turn (OpenAI) --------------------
async function getAiTurn({ lead, transcript }) {
  if (!process.env.OPENAI_API_KEY) {
    return {
      reply: "Sorry — I’m having a little technical hiccup. I’ll send you a text to get you booked in.",
      intent: "LATER",
      end_state: "LATER_DONE",
      booking: {}
    };
  }

  const homeowner = normalizeYesNo(lead?.isHomeowner || "");

  const system = `
You are "Nicola", a friendly UK caller for Greenbug Energy.
Context: You are calling a lead who filled a form requesting a FREE home energy survey about solar panels.
Goal: Have a natural conversation and book a site survey.

Hard Rules (IMPORTANT):
- Ask ONE question at a time.
- Keep it human, warm, short sentences. UK tone.
- If the form already has isHomeowner as "Yes" or "No", DO NOT ask "are you the homeowner" again. Just acknowledge it and move on.
- Only ask homeowner if isHomeowner is blank/unknown.
- Confirm ADDRESS only if missing/unclear. If address exists, just confirm postcode briefly.
- To BOOK: ask for preferred day + whether morning/afternoon. Do NOT promise an exact time. Say you'll text confirmation.

Output MUST be valid JSON only with keys: reply, intent, end_state, booking
intent must be one of: CONTINUE, BOOK, LATER, NOT_INTERESTED
end_state must be one of: CONTINUE, BOOKED_DONE, LATER_DONE, NOT_INTERESTED
booking may include: preferred_day, preferred_window, notes, confirmed_address
`.trim();

  const leadSummary = {
    name: lead?.name || "",
    phone: lead?.phone || "",
    email: lead?.email || "",
    address: lead?.address || "",
    postcode: lead?.postcode || "",
    propertyType: lead?.propertyType || "",
    isHomeowner: homeowner
  };

  const messages = [
    { role: "system", content: system },
    { role: "user", content: `Lead details from form: ${JSON.stringify(leadSummary)}` },
    ...transcript.slice(-10).map((t) => ({
      role: t.role === "assistant" ? "assistant" : "user",
      content: t.text
    }))
  ];

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.35,
      messages
    })
  });

  const data = await resp.json();
  const raw = data?.choices?.[0]?.message?.content || "";

  try {
    const parsed = JSON.parse(raw);
    if (!parsed.reply) throw new Error("No reply in JSON");
    return {
      reply: String(parsed.reply),
      intent: parsed.intent || "CONTINUE",
      end_state: parsed.end_state || "CONTINUE",
      booking: parsed.booking || {}
    };
  } catch (e) {
    // IMPORTANT: do NOT default to “homeowner?” here because it causes loops.
    return {
      reply: fallbackNextQuestion(lead),
      intent: "CONTINUE",
      end_state: "CONTINUE",
      booking: {}
    };
  }
}

// -------------------- Post to GHL inbound webhook trigger --------------------
async function postToGhlBookingWebhook({ lead, booking, transcript }) {
  const url = process.env.GHL_BOOKING_TRIGGER_URL;
  if (!url) throw new Error("Missing GHL_BOOKING_TRIGGER_URL env var");

  const payload = {
    agent: "Nicola",
    source: "AI_CALL",
    intent: "BOOK",
    phone: lead?.phone || "",
    name: lead?.name || "",
    email: lead?.email || "",
    address: lead?.address || "",
    postcode: lead?.postcode || "",
    propertyType: lead?.propertyType || "",
    isHomeowner: normalizeYesNo(lead?.isHomeowner || ""),
    booking: {
      preferred_day: booking?.preferred_day || "",
      preferred_window: booking?.preferred_window || "",
      confirmed_address: booking?.confirmed_address || "",
      notes: booking?.notes || ""
    },
    transcript: transcript
      .map((t) => `${t.role === "assistant" ? "Nicola" : "Lead"}: ${t.text}`)
      .join("\n")
  };

  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!r.ok) {
    const errText = await r.text().catch(() => "");
    throw new Error(`GHL webhook failed: ${r.status} ${errText}`);
  }
}

// IMPORTANT: listen on Railway port
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`Listening on ${PORT}`));
