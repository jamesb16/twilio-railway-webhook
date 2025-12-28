const express = require("express");
const twilio = require("twilio");

const app = express();

// GHL often sends JSON; Twilio webhooks are x-www-form-urlencoded
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));

/**
 * sessions[CallSid] = {
 *   lead: { name, phone, email, address, postcode, propertyType, isHomeowner },
 *   transcript: [{ role: "assistant"|"user", text }],
 *   turns: number,
 *   stage: "OPEN"|"CONFIRM_ADDRESS"|"ASK_DAY"|"ASK_WINDOW"|"CONFIRM_CLOSE"|"DONE",
 *   retries: { confirmAddress: number, askDay: number, askWindow: number },
 *   booking: { preferred_day, preferred_window, confirmed_address, notes }
 * }
 */
const sessions = new Map();

// Use fetch safely on Railway (Node 18+ has global fetch; fallback just in case)
const fetchFn =
  global.fetch ||
  ((...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args)));

// -------------------- Helpers: speech normalization --------------------
function norm(s) {
  return String(s || "").trim().toLowerCase();
}

function isYes(s) {
  const t = norm(s);
  return (
    t === "yes" ||
    t === "yeah" ||
    t === "yeh" ||
    t === "yep" ||
    t === "aye" ||
    t === "yup" ||
    t.includes("yes") ||
    t.includes("yeah") ||
    t.includes("yeh") ||
    t.includes("aye") ||
    t.includes("correct") ||
    t.includes("that’s right") ||
    t.includes("thats right") ||
    t.includes("right")
  );
}

function isNo(s) {
  const t = norm(s);
  return (
    t === "no" ||
    t === "nope" ||
    t === "nah" ||
    t.includes("no") ||
    t.includes("not") ||
    t.includes("wrong") ||
    t.includes("incorrect")
  );
}

function extractWindow(s) {
  const t = norm(s);
  if (t.includes("morning") || t.includes("am") || t.includes("a.m")) return "Morning";
  if (t.includes("afternoon") || t.includes("pm") || t.includes("p.m")) return "Afternoon";
  if (t.includes("evening")) return "Evening"; // optional
  return "";
}

function extractDay(s) {
  const t = norm(s);
  const days = [
    "monday","tuesday","wednesday","thursday","friday","saturday","sunday",
    "mon","tue","tues","wed","thu","thur","thurs","fri","sat","sun"
  ];
  for (const d of days) {
    if (t.includes(d)) {
      // Normalise short forms
      if (d.startsWith("mon")) return "Monday";
      if (d.startsWith("tue")) return "Tuesday";
      if (d.startsWith("wed")) return "Wednesday";
      if (d.startsWith("thu")) return "Thursday";
      if (d.startsWith("fri")) return "Friday";
      if (d.startsWith("sat")) return "Saturday";
      if (d.startsWith("sun")) return "Sunday";
    }
  }
  // “tomorrow” / “next week” etc (basic)
  if (t.includes("tomorrow")) return "Tomorrow";
  if (t.includes("next week")) return "Next week";
  return "";
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function ttsUrl(baseUrl, text) {
  return `${baseUrl}/tts?text=${encodeURIComponent(text)}`;
}

function ensureSession(callSid) {
  if (!sessions.has(callSid)) {
    sessions.set(callSid, {
      lead: {},
      transcript: [],
      turns: 0,
      stage: "OPEN",
      retries: { confirmAddress: 0, askDay: 0, askWindow: 0 },
      booking: { preferred_day: "", preferred_window: "", confirmed_address: "", notes: "" }
    });
  }
  return sessions.get(callSid);
}

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

    return res.status(200).json({ ok: true, message: "Call triggered", sid: call.sid, to, name });
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

  const session = ensureSession(callSid);
  session.lead = { name, phone, email, address, postcode, propertyType, isHomeowner };
  session.transcript = [{ role: "assistant", text: "Call started." }];
  session.turns = 0;
  session.stage = "OPEN";
  session.retries = { confirmAddress: 0, askDay: 0, askWindow: 0 };
  session.booking = { preferred_day: "", preferred_window: "", confirmed_address: "", notes: "" };

  sessions.set(callSid, session);

  const opening = `Hi ${name}. It’s Nicola from Greenbug Energy. You requested a free home energy survey about solar panels — have I caught you at an okay time?`;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${ttsUrl(baseUrl, opening)}</Play>
  <Gather input="speech" language="en-GB" action="${baseUrl}/twilio/speech" method="POST" speechTimeout="auto" timeout="6"/>
  <Play>${ttsUrl(baseUrl, "No worries — I’ll send you a text and you can pick a time that suits. Bye for now.")}</Play>
  <Hangup/>
</Response>`;

  res.type("text/xml").send(twiml);
});

// -------------------- Twilio: speech capture (FAST response with filler) --------------------
// IMPORTANT: This endpoint returns immediately with filler + redirect, to reduce the “dead air”.
app.post("/twilio/speech", async (req, res) => {
  const baseUrl = process.env.PUBLIC_BASE_URL;
  const callSid = req.body.CallSid;
  const speech = (req.body.SpeechResult || "").trim();
  const confidence = req.body.Confidence;

  const session = ensureSession(callSid);
  session.turns = (session.turns || 0) + 1;

  if (speech) session.transcript.push({ role: "user", text: speech });

  console.log("Speech:", { callSid, speech, confidence, stage: session.stage });

  // Safety stop
  if (session.turns >= 14) {
    session.stage = "DONE";
    sessions.set(callSid, session);
    const bye = "Thanks for that — I’ll send you a quick text and we can take it from there. Bye for now.";
    const twimlEnd = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${ttsUrl(baseUrl, bye)}</Play>
  <Hangup/>
</Response>`;
    return res.type("text/xml").send(twimlEnd);
  }

  sessions.set(callSid, session);

  // Filler to mask thinking / redirect gap
  const filler = pick([
    "Mm-hmm… one sec.",
    "Okay… just checking that.",
    "Perfect… just a moment.",
    "Right… bear with me a sec."
  ]);

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${ttsUrl(baseUrl, filler)}</Play>
  <Redirect method="POST">${baseUrl}/twilio/next</Redirect>
</Response>`;

  return res.type("text/xml").send(twiml);
});

// -------------------- Twilio: main logic step (after filler) --------------------
app.post("/twilio/next", async (req, res) => {
  const baseUrl = process.env.PUBLIC_BASE_URL;
  const callSid = req.body.CallSid || "";
  const session = ensureSession(callSid);

  // If Twilio ever hits here without a session, be polite and end
  if (!session.lead || !session.lead.phone) {
    const twimlOops = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${ttsUrl(baseUrl, "Sorry — I’ve lost the details on my side. I’ll send you a text to book in. Bye for now.")}</Play>
  <Hangup/>
</Response>`;
    return res.type("text/xml").send(twimlOops);
  }

  const lastUser = [...session.transcript].reverse().find(t => t.role === "user")?.text || "";

  // Stage machine:
  // OPEN -> CONFIRM_ADDRESS -> ASK_DAY -> ASK_WINDOW -> CONFIRM_CLOSE -> DONE

  let reply = "";
  let shouldHangup = false;

  // 1) OPEN: if they said yes-ish, move to confirm address; if no-ish, end politely.
  if (session.stage === "OPEN") {
    if (isNo(lastUser)) {
      reply = "No problem at all. I’ll send you a quick text and you can pick a time that suits. Bye for now.";
      shouldHangup = true;
      session.stage = "DONE";
    } else {
      session.stage = "CONFIRM_ADDRESS";
      // fallthrough to confirm address
    }
  }

  // 2) CONFIRM_ADDRESS (but DO NOT ask for full address again if we already have it)
  if (session.stage === "CONFIRM_ADDRESS") {
    const hasAddress = !!norm(session.lead.address);
    const hasPostcode = !!norm(session.lead.postcode);

    // If we have address+postcode, confirm it (once), otherwise ask for missing piece.
    if (hasAddress || hasPostcode) {
      const addrLine = [session.lead.address, session.lead.postcode].filter(Boolean).join(", ");
      if (session.retries.confirmAddress === 0) {
        reply = `Perfect. I’ve got the survey address as ${addrLine}. Is that correct?`;
        session.retries.confirmAddress++;
      } else {
        // We’re expecting a yes/no now
        if (isYes(lastUser)) {
          session.booking.confirmed_address = addrLine;
          session.stage = "ASK_DAY";
        } else if (isNo(lastUser)) {
          reply = "No worries — what’s the correct postcode for the survey address?";
          session.retries.confirmAddress++;
          // stay in CONFIRM_ADDRESS but now we’re collecting postcode
          session.booking.notes = (session.booking.notes || "") + " Address mismatch reported.";
        } else {
          // Didn’t catch yes/no
          reply = "Sorry — just to confirm, is that address correct?";
          session.retries.confirmAddress++;
        }

        // If too many retries, bail to text
        if (session.retries.confirmAddress >= 4 && session.stage === "CONFIRM_ADDRESS") {
          reply = "No worries — I’ll send you a text to confirm the address and get you booked in. Bye for now.";
          shouldHangup = true;
          session.stage = "DONE";
        }
      }
    } else {
      // Missing address info entirely
      if (session.retries.confirmAddress === 0) {
        reply = "Quick one — what’s the postcode for the survey address?";
        session.retries.confirmAddress++;
      } else {
        // If user said a postcode, store it
        const maybe = norm(lastUser);
        if (maybe.length >= 5) {
          session.lead.postcode = lastUser.trim();
          session.booking.confirmed_address = session.lead.postcode;
          session.stage = "ASK_DAY";
        } else {
          reply = "Sorry — what’s the postcode there?";
          session.retries.confirmAddress++;
        }
      }
    }
  }

  // 3) ASK_DAY
  if (session.stage === "ASK_DAY") {
    const day = extractDay(lastUser);

    if (!day) {
      if (session.retries.askDay === 0) {
        reply = "Lovely. What day suits you best for the survey?";
        session.retries.askDay++;
      } else {
        // If they answered but we didn't parse a day, ask again with examples
        reply = "No worries — is that more like Monday, Tuesday, or later in the week?";
        session.retries.askDay++;
      }

      if (session.retries.askDay >= 4) {
        reply = "No problem — I’ll text you a link to pick a day that suits. Bye for now.";
        shouldHangup = true;
        session.stage = "DONE";
      }
    } else {
      session.booking.preferred_day = day;
      session.stage = "ASK_WINDOW";
    }
  }

  // 4) ASK_WINDOW
  if (session.stage === "ASK_WINDOW") {
    const win = extractWindow(lastUser);

    if (!win) {
      if (session.retries.askWindow === 0) {
        reply = "Great — would you prefer morning or afternoon?";
        session.retries.askWindow++;
      } else {
        reply = "Just checking — morning or afternoon work better for you?";
        session.retries.askWindow++;
      }

      if (session.retries.askWindow >= 4) {
        reply = "No worries — I’ll text you to choose a time window. Bye for now.";
        shouldHangup = true;
        session.stage = "DONE";
      }
    } else {
      session.booking.preferred_window = win;
      session.stage = "CONFIRM_CLOSE";
    }
  }

  // 5) CONFIRM_CLOSE -> post to GHL webhook once and end
  if (session.stage === "CONFIRM_CLOSE") {
    // Post booking webhook
    try {
      await postToGhlBookingWebhook({
        lead: session.lead,
        booking: session.booking,
        transcript: session.transcript
      });
    } catch (e) {
      console.error("GHL webhook post failed:", e?.message || e);
      // Still close politely
    }

    reply = `Perfect. I’ve got ${session.booking.preferred_day} ${session.booking.preferred_window}. I’ll send you a text or email confirmation, and if you need to change it you can just reply. Thanks so much — bye for now.`;
    shouldHangup = true;
    session.stage = "DONE";
  }

  // If we didn’t set a reply (can happen on stage transitions), prompt appropriately
  if (!reply && session.stage === "ASK_DAY") reply = "What day suits you best for the survey?";
  if (!reply && session.stage === "ASK_WINDOW") reply = "Morning or afternoon work better?";
  if (!reply && session.stage === "CONFIRM_ADDRESS") {
    const addrLine = [session.lead.address, session.lead.postcode].filter(Boolean).join(", ");
    reply = `I’ve got the address as ${addrLine}. Is that correct?`;
  }

  session.transcript.push({ role: "assistant", text: reply });
  sessions.set(callSid, session);

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${ttsUrl(baseUrl, reply)}</Play>
  ${
    shouldHangup
      ? "<Hangup/>"
      : `<Gather input="speech" language="en-GB" action="${baseUrl}/twilio/speech" method="POST" speechTimeout="auto" timeout="7"/>`
  }
  ${
    shouldHangup
      ? ""
      : `<Play>${ttsUrl(baseUrl, "Sorry — I didn’t catch that. Can you say that one more time?")}</Play>`
  }
</Response>`;

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

// IMPORTANT: listen on Railway port
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`Listening on ${PORT}`));
