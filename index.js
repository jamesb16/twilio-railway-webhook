const express = require("express");
const twilio = require("twilio");

// --- fetch fallback (prevents crashes if Node < 18) ---
let fetchFn = global.fetch;
if (!fetchFn) {
  fetchFn = (...args) => import("node-fetch").then(({ default: f }) => f(...args));
}

const app = express();

// GHL often sends JSON; Twilio webhooks are x-www-form-urlencoded
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));

/**
 * sessions[CallSid] = {
 *   lead: { name, phone, email, address, postcode, propertyType, isHomeowner },
 *   transcript: [{ role: "assistant"|"user", text }],
 *   turns: number,
 *   state: "OPEN"|"CONFIRM_ADDRESS"|"ASK_DAY"|"ASK_WINDOW"|"DONE",
 *   slots: { preferred_day?: string, preferred_window?: string, confirmed_address?: string }
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
  const isHomeowner = (req.query.isHomeowner || "").toString();

  const callSid = req.body.CallSid || req.query.CallSid || "";

  sessions.set(callSid, {
    lead: { name, phone, email, address, postcode, propertyType, isHomeowner },
    transcript: [{ role: "assistant", text: "Call started." }],
    turns: 0,
    state: "OPEN",
    slots: {}
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

// -------------------- Twilio: handle speech (slot-filling + short natural flow) --------------------
app.post("/twilio/speech", async (req, res) => {
  const baseUrl = process.env.PUBLIC_BASE_URL;
  const callSid = req.body.CallSid;
  const speechRaw = (req.body.SpeechResult || "").trim();
  const speech = normalizeSpeech(speechRaw);
  const confidence = req.body.Confidence;

  const session = sessions.get(callSid) || { lead: {}, transcript: [], turns: 0, state: "OPEN", slots: {} };
  session.turns = (session.turns || 0) + 1;

  if (speechRaw) session.transcript.push({ role: "user", text: speechRaw });

  console.log("Speech:", { callSid, speechRaw, speech, confidence, state: session.state });

  // Safety stop
  if (session.turns >= 12) {
    const bye = "Thanks — I’ll send you a quick text and we’ll take it from there. Bye for now.";
    const twimlEnd = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${baseUrl}/tts?text=${encodeURIComponent(bye)}</Play>
  <Hangup/>
</Response>`;
    sessions.set(callSid, session);
    return res.type("text/xml").send(twimlEnd);
  }

  // Handle “busy / later / not interested”
  if (isLater(speech)) {
    const msg = withFiller("No problem at all — I’ll text you in a minute and you can pick a time that suits. Bye for now.");
    const twimlLater = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${baseUrl}/tts?text=${encodeURIComponent(msg)}</Play>
  <Hangup/>
</Response>`;
    sessions.set(callSid, session);
    return res.type("text/xml").send(twimlLater);
  }

  if (isNotInterested(speech)) {
    const msg = withFiller("No worries — thanks for your time. If you ever want a survey later, just reply to our text. Bye for now.");
    const twimlNo = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${baseUrl}/tts?text=${encodeURIComponent(msg)}</Play>
  <Hangup/>
</Response>`;
    sessions.set(callSid, session);
    return res.type("text/xml").send(twimlNo);
  }

  // If they said yes/yeah/aye to “okay time?”, move on.
  if (session.state === "OPEN") {
    // confirm address step (only once)
    session.state = "CONFIRM_ADDRESS";
  }

  // CONFIRM_ADDRESS: if we have address, confirm it; else ask for it.
  if (session.state === "CONFIRM_ADDRESS") {
    const addr = (session.lead.address || "").trim();
    const pc = (session.lead.postcode || "").trim();

    if (addr || pc) {
      // if they already confirmed once, don’t loop
      if (!session.slots.confirmed_address) {
        const confirmLine =
          addr && pc
            ? `Perfect — I’ve got the address as ${addr}, ${pc}. Is that correct?`
            : addr
              ? `Perfect — I’ve got the address as ${addr}. Is that correct?`
              : `Perfect — I’ve got your postcode as ${pc}. Is that correct?`;

        const msg = withFiller(confirmLine);
        const twiml = twimlGather(baseUrl, msg, 7);
        sessions.set(callSid, session);
        return res.type("text/xml").send(twiml);
      }

      // If already confirmed, move on
      session.state = "ASK_DAY";
    } else {
      const msg = withFiller("Brilliant — what’s the best address or postcode for the survey?");
      const twiml = twimlGather(baseUrl, msg, 8);
      sessions.set(callSid, session);
      return res.type("text/xml").send(twiml);
    }
  }

  // If we asked “is that correct?” — accept yeh/aye/yes and mark confirmed once.
  if (!session.slots.confirmed_address && looksLikeYes(speech)) {
    session.slots.confirmed_address = "yes";
    session.state = "ASK_DAY";
  } else if (!session.slots.confirmed_address && looksLikeNo(speech)) {
    // If they correct it, capture whatever they said as new address snippet (basic)
    session.slots.confirmed_address = "corrected";
    if (speechRaw) {
      session.lead.address = speechRaw; // best-effort
    }
    session.state = "ASK_DAY";
  }

  // ASK_DAY: get preferred day (Mon/Tue/etc or “tomorrow/next week”)
  if (session.state === "ASK_DAY") {
    // try extract from their latest speech first
    const day = extractDay(speechRaw);
    if (day) session.slots.preferred_day = day;

    if (!session.slots.preferred_day) {
      const msg = withFiller("Lovely — what day suits you best for the survey?");
      const twiml = twimlGather(baseUrl, msg, 7);
      sessions.set(callSid, session);
      return res.type("text/xml").send(twiml);
    }

    session.state = "ASK_WINDOW";
  }

  // ASK_WINDOW: morning/afternoon
  if (session.state === "ASK_WINDOW") {
    const win = extractWindow(speechRaw);
    if (win) session.slots.preferred_window = win;

    if (!session.slots.preferred_window) {
      const msg = withFiller("And is that better in the morning or the afternoon?");
      const twiml = twimlGather(baseUrl, msg, 7);
      sessions.set(callSid, session);
      return res.type("text/xml").send(twiml);
    }

    session.state = "DONE";
  }

  // DONE: post to GHL webhook + close call
  if (session.state === "DONE") {
    const final = withFiller(
      `Perfect. I’ll get that booked in for ${session.slots.preferred_day} ${session.slots.preferred_window}. ` +
      `We’ll send you a text to confirm — and if you need to change anything, just reply to it. Bye for now.`
    );

    // post booking (don’t block the hangup if it errors)
    postToGhlBookingWebhook({
      lead: session.lead,
      booking: {
        preferred_day: session.slots.preferred_day,
        preferred_window: session.slots.preferred_window,
        confirmed_address: session.lead.address || session.lead.postcode || "",
        notes: ""
      },
      transcript: session.transcript
    }).catch((e) => console.error("GHL webhook post failed:", e?.message || e));

    sessions.set(callSid, session);

    const twimlDone = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${baseUrl}/tts?text=${encodeURIComponent(final)}</Play>
  <Hangup/>
</Response>`;
    return res.type("text/xml").send(twimlDone);
  }

  // Fallback (shouldn’t really hit)
  const msg = withFiller("Sorry — can you say that one more time?");
  const twiml = twimlGather(baseUrl, msg, 7);
  sessions.set(callSid, session);
  return res.type("text/xml").send(twiml);
});

// -------------------- ElevenLabs TTS endpoint (Twilio plays this) --------------------
app.get("/tts", async (req, res) => {
  try {
    const text = String(req.query.text || "").trim();
    if (!text) return res.status(400).send("Missing text");

    if (!process.env.ELEVENLABS_API_KEY || !process.env.ELEVENLABS_VOICE_ID) {
      return res.status(500).send("Missing ELEVENLABS_API_KEY or ELEVENLABS_VOICE_ID");
    }

    const safeText = text.slice(0, 600);
    const voiceId = process.env.ELEVENLABS_VOICE_ID;
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;

    const r = await fetchFn(url, {
      method: "POST",
      headers: {
        "xi-api-key": process.env.ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
        Accept: "audio/mpeg"
      },
      body: JSON.stringify({
        text: safeText,
        model_id: "eleven_multilingual_v2",
        voice_settings: { stability: 0.4, similarity_boost: 0.85 }
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

  if (payload.CallStatus === "completed") {
    sessions.delete(payload.CallSid);
  }

  res.status(200).send("ok");
});

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

  const r = await fetchFn(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!r.ok) {
    const errText = await r.text().catch(() => "");
    throw new Error(`GHL webhook failed: ${r.status} ${errText}`);
  }
}

// -------------------- Helpers --------------------
function twimlGather(baseUrl, text, timeoutSeconds) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${baseUrl}/tts?text=${encodeURIComponent(text)}</Play>
  <Gather input="speech" language="en-GB" action="${baseUrl}/twilio/speech" method="POST" speechTimeout="auto" timeout="${timeoutSeconds}"/>
  <Play>${baseUrl}/tts?text=${encodeURIComponent("Sorry — I didn’t catch that. Can you say that one more time?")}</Play>
</Response>`;
}

function normalizeSpeech(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^\w\s']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeYes(s) {
  const t = normalizeSpeech(s);
  return ["yes", "yeah", "yeh", "yep", "yup", "aye", "correct", "that's right", "thats right", "right"].some((k) =>
    t.includes(k)
  );
}

function looksLikeNo(s) {
  const t = normalizeSpeech(s);
  return ["no", "nah", "nope", "not really", "wrong", "incorrect"].some((k) => t.includes(k));
}

function isLater(s) {
  const t = normalizeSpeech(s);
  return ["later", "not now", "busy", "call back", "another time", "tomorrow", "text me"].some((k) => t.includes(k));
}

function isNotInterested(s) {
  const t = normalizeSpeech(s);
  return ["not interested", "stop", "don't call", "dont call", "leave me alone"].some((k) => t.includes(k));
}

function extractWindow(raw) {
  const t = normalizeSpeech(raw);
  if (t.includes("morning") || t.includes("am")) return "morning";
  if (t.includes("afternoon") || t.includes("pm") || t.includes("evening")) return "afternoon";
  return "";
}

function extractDay(raw) {
  const t = normalizeSpeech(raw);
  const days = [
    ["monday", "mon"],
    ["tuesday", "tue", "tues"],
    ["wednesday", "wed"],
    ["thursday", "thu", "thur", "thurs"],
    ["friday", "fri"],
    ["saturday", "sat"],
    ["sunday", "sun"]
  ];
  for (const [full, ...alts] of days) {
    if (t.includes(full) || alts.some((a) => t.includes(a))) return full;
  }
  if (t.includes("tomorrow")) return "tomorrow";
  if (t.includes("next week")) return "next week";
  return "";
}

function withFiller(text) {
  // make it feel human + hides “thinking” gap a bit
  const fillers = [
    "Mm-hmm. ",
    "Okay. ",
    "Right. ",
    "One sec… ",
    "Got you. ",
    "Perfect. "
  ];
  // ~35% chance
  if (Math.random() < 0.35) return fillers[Math.floor(Math.random() * fillers.length)] + text;
  return text;
}

// IMPORTANT: listen on Railway port
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`Listening on ${PORT}`));
