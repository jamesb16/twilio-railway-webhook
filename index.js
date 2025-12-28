const express = require("express");
const twilio = require("twilio");

const app = express();

// GHL often sends JSON; Twilio webhooks are x-www-form-urlencoded
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));

// -------------------- In-memory call sessions (simple + effective) --------------------
/**
 * sessions[CallSid] = {
 *   lead: { name, phone, email, address, postcode, propertyType, isHomeowner },
 *   transcript: [{ role: "assistant"|"user", text }],
 *   turns: number
 * }
 */
const sessions = new Map();

// -------------------- Health --------------------
app.get("/", (req, res) => res.status(200).send("OK - Greenbug outbound AI is running"));
app.get("/health", (req, res) => res.status(200).json({ ok: true }));

// -------------------- Trigger outbound call from GHL --------------------
app.post("/ghl/lead", async (req, res) => {
  try {
    const body = req.body || {};

    // Best-effort extraction (GHL payloads vary)
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

    const isHomeowner =
      body.isHomeowner ||
      body["Are You The Homeowner"] ||
      body.contact?.isHomeowner ||
      "";

    // New: Log the preferred_day received in the request
    const preferred_day = body.booking?.preferred_day;
    console.log('Received preferred_day:', preferred_day);

    // Format the preferred_day to match the GHL required format (YYYY-MM-DD HH:MM:SS)
    const formattedPreferredDay = new Date(preferred_day).toISOString().slice(0, 19).replace("T", " ");
    console.log('Formatted preferred_day:', formattedPreferredDay);

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

    // Make the call – Twilio will hit /twilio/voice for TwiML
    const call = await client.calls.create({
      to,
      from,
      url: `${baseUrl}/twilio/voice?name=${encodeURIComponent(name)}&phone=${encodeURIComponent(to)}&email=${encodeURIComponent(email)}&address=${encodeURIComponent(address)}&postcode=${encodeURIComponent(postcode)}&propertyType=${encodeURIComponent(propertyType)}&isHomeowner=${encodeURIComponent(isHomeowner)}&preferred_day=${encodeURIComponent(formattedPreferredDay)}`,
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
  const isHomeowner = (req.query.isHomeowner || "").toString();
  const preferred_day = (req.query.preferred_day || "").toString();

  const callSid = req.body.CallSid || req.query.CallSid || "";

  // Create / reset session
  sessions.set(callSid, {
    lead: { name, phone, email, address, postcode, propertyType, isHomeowner, preferred_day },
    transcript: [{ role: "assistant", text: "Call started." }],
    turns: 0
  });

  // Nicola’s opening (human + natural)
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

// -------------------- Twilio: handle speech + continue conversation --------------------
app.post("/twilio/speech", async (req, res) => {
  const baseUrl = process.env.PUBLIC_BASE_URL;
  const callSid = req.body.CallSid;
  const speech = (req.body.SpeechResult || "").trim();
  const confidence = req.body.Confidence;

  const session = sessions.get(callSid) || { lead: {}, transcript: [], turns: 0 };
  session.turns = (session.turns || 0) + 1;

  if (speech) session.transcript.push({ role: "user", text: speech });

  console.log("Speech:", { callSid, speech, confidence });

  // Safety stop: don’t loop forever
  if (session.turns >= 10) {
    const bye = "Thanks for that — I’ll send you a quick text and we can take it from there. Bye for now.";
    const twimlEnd = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${baseUrl}/tts?text=${encodeURIComponent(bye)}</Play>
  <Hangup/>
</Response>`;
    sessions.set(callSid, session);
    return res.type("text/xml").send(twimlEnd);
  }

  // Get AI reply + intent (BOOK / LATER / NOT_INTERESTED / CONTINUE)
  const ai = await getAiTurn({
    lead: session.lead,
    transcript: session.transcript
  });

  session.transcript.push({ role: "assistant", text: ai.reply });

  // If BOOK: post to GHL webhook immediately
  if (ai.intent === "BOOK") {
    try {
      await postToGhlBookingWebhook({
        lead: session.lead,
        booking: ai.booking || {},
        transcript: session.transcript
      });
    } catch (e) {
      console.error("GHL webhook post failed:", e?.message || e);
      // Still continue the call politely
    }
  }

  sessions.set(callSid, session);

  // Decide whether to hang up or continue gathering
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

  res.type("text/xml").send(twiml);
});

// -------------------- ElevenLabs TTS endpoint (Twilio plays this) --------------------
app.get("/tts", async (req, res) => {
  try {
    const text = String(req.query.text || "").trim();
    if (!text) return res.status(400).send("Missing text");

    if (!process.env.ELEVENLABS_API_KEY || !process.env.ELEVENLABS_VOICE_ID) {
      return res.status(500).send("Missing ELEVENLABS_API_KEY or ELEVENLABS_VOICE_ID");
    }

    // Keep it sane
    const safeText = text.slice(0, 600);

    const voiceId = process.env.ELEVENLABS_VOICE_ID;
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

  // Cleanup finished calls
  if (payload.CallStatus === "completed") {
    sessions.delete(payload.CallSid);
  }

  res.status(200).send("ok");
});

// -------------------- AI turn (OpenAI) --------------------
async function getAiTurn({ lead, transcript }) {
  if (!process.env.OPENAI_API_KEY) {
    // Fallback (never block call)
    return {
      reply: "Sorry — I’m having a little technical hiccup. I’ll send you a text to get you booked in.",
      intent: "LATER",
      end_state: "LATER_DONE"
    };
  }

  const system = `
You are "Nicola", a friendly UK caller for Greenbug Energy.
Context: You are calling a lead who filled a form requesting a FREE home energy survey about solar panels.
Goal: Have a natural conversation and book a site survey.

Rules:
- Sound human, warm, short sentences. UK tone. No robotic scripts.
- Ask ONE question at a time.
- Confirm the ADDRESS if missing/unclear. If they already gave it, just confirm postcode.
- Qualify lightly: homeowner? property type? approx monthly electric bill? roof shading? timeframe to install?
- If they are busy: offer to book and text details. If not interested: be polite and end.
- To BOOK: ask for preferred day and whether morning/afternoon. Do NOT promise an exact time. Say you’ll text confirmation.
- Output MUST be valid JSON only with keys: reply, intent, end_state, booking
- intent must be one of: CONTINUE, BOOK, LATER, NOT_INTERESTED
- end_state must be one of: CONTINUE, BOOKED_DONE, LATER_DONE, NOT_INTERESTED
- booking is an object and may include: preferred_day, preferred_window, notes, confirmed_address
`;

  const leadSummary = {
    name: lead?.name || "",
    phone: lead?.phone || "",
    email: lead?.email || "",
    address: lead?.address || "",
    postcode: lead?.postcode || "",
    propertyType: lead?.propertyType || "",
    isHomeowner: lead?.isHomeowner || ""
  };

  const messages = [
    { role: "system", content: system.trim() },
    {
      role: "user",
      content: `Lead details from form (may be partial): ${JSON.stringify(leadSummary)}`
    },
    ...transcript.slice(-12).map((t) => ({
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
      temperature: 0.4,
      messages
    })
  });

  const data = await resp.json();
  const raw = data?.choices?.[0]?.message?.content || "";

  // Parse JSON safely
  try {
    const parsed = JSON.parse(raw);
    // Hard guardrails
    if (!parsed.reply) throw new Error("No reply");
    return {
      reply: String(parsed.reply),
      intent: parsed.intent || "CONTINUE",
      end_state: parsed.end_state || "CONTINUE",
      booking: parsed.booking || {}
    };
  } catch (e) {
    // If the model outputs non-JSON, recover with a generic prompt
    return {
      reply: "Perfect — just a quick one: are you the homeowner at the property?",
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
    isHomeowner: lead?.isHomeowner || "",
    booking: {
      preferred_day: booking?.preferred_day || "",
      preferred_window: booking?.preferred_window || "",
      confirmed_address: booking?.confirmed_address || "",
      notes: booking?.notes || ""
    },
    transcript: transcript.map((t) => `${t.role === "assistant" ? "Nicola" : "Lead"}: ${t.text}`).join("\n")
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
