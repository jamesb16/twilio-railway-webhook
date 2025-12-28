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
 *   booking: { preferred_day, preferred_window, confirmed_address, notes, start_datetime }
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
    t.includes("that's right") ||
    t.includes("thats right") ||
    t.includes("right") ||
    t.includes("sounds good") ||
    t === "ok" ||
    t === "okay" ||
    t.includes("ok")
  );
}

function isNo(s) {
  const t = norm(s);
  return (
    t === "no" ||
    t === "nope" ||
    t === "nah" ||
    t.includes("not really") ||
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
  if (t.includes("evening")) return "Evening"; // you said no evening, but keep for safety
  return "";
}

function extractDay(s) {
  const t = norm(s);

  const map = [
    { keys: ["monday", "mon"], value: "Monday" },
    { keys: ["tuesday", "tue", "tues"], value: "Tuesday" },
    { keys: ["wednesday", "wed"], value: "Wednesday" },
    { keys: ["thursday", "thu", "thur", "thurs"], value: "Thursday" },
    { keys: ["friday", "fri"], value: "Friday" },
    { keys: ["saturday", "sat"], value: "Saturday" },
    { keys: ["sunday", "sun"], value: "Sunday" }
  ];

  for (const item of map) {
    for (const k of item.keys) {
      if (t.includes(k)) return item.value;
    }
  }

  if (t.includes("tomorrow")) return "Tomorrow";
  if (t.includes("next week")) return "Next week";

  return "";
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ✅ IMPORTANT: correct helper name (this is what broke earlier)
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
      booking: {
        preferred_day: "",
        preferred_window: "",
        confirmed_address: "",
        notes: "",
        start_datetime: ""
      }
    });
  }
  return sessions.get(callSid);
}

// -------------------- Calendar helper --------------------
// Goal:
// - Mon–Fri only
// - Morning slots: 09:00 or 10:30 (90 mins each)
// - Afternoon slots: 13:00 or 14:30 (90 mins each)
// - Output format: "YYYY-MM-DD HH:MM" in Europe/London

function pad2(n) {
  return String(n).padStart(2, "0");
}

function formatInLondon(dateObj) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(dateObj);

  const get = (type) => parts.find((p) => p.type === type)?.value;

  // en-GB gives DD/MM/YYYY, but we build our own parts:
  const yyyy = get("year");
  const mm = get("month");
  const dd = get("day");
  const hh = get("hour");
  const mi = get("minute");

  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

function nextWeekdayDate(fromDate, targetDow) {
  // targetDow: 1=Mon ... 5=Fri (JS: 0=Sun)
  const d = new Date(fromDate);
  const current = d.getDay();
  let add = (targetDow - current + 7) % 7;
  if (add === 0) add = 7; // next occurrence, not today
  d.setDate(d.getDate() + add);
  return d;
}

function clampToMonFri(d) {
  // If Sat(6) -> move to Mon(+2), Sun(0) -> move to Mon(+1)
  const day = d.getDay();
  if (day === 6) d.setDate(d.getDate() + 2);
  if (day === 0) d.setDate(d.getDate() + 1);
  return d;
}

function slotTimesForWindow(win) {
  if (win === "Morning") return [{ h: 9, m: 0 }, { h: 10, m: 30 }];
  if (win === "Afternoon") return [{ h: 13, m: 0 }, { h: 14, m: 30 }];
  // no evenings in your rules; fallback to morning
  return [{ h: 9, m: 0 }, { h: 10, m: 30 }];
}

function pickSlotIndex(stableKey) {
  // stable “random”: pick slot 0 or 1 based on callSid hash-ish
  const s = String(stableKey || "");
  let sum = 0;
  for (let i = 0; i < s.length; i++) sum += s.charCodeAt(i);
  return sum % 2;
}

function computeStartDateTime(preferredDay, preferredWindow, stableKey) {
  const day = String(preferredDay || "").trim();
  const win = String(preferredWindow || "").trim();

  const now = new Date();
  let targetDate = new Date(now);

  const weekdayMap = {
    Monday: 1,
    Tuesday: 2,
    Wednesday: 3,
    Thursday: 4,
    Friday: 5
  };

  if (day === "Tomorrow") {
    targetDate.setDate(targetDate.getDate() + 1);
    targetDate = clampToMonFri(targetDate);
  } else if (day === "Next week") {
    // Next Monday
    targetDate = nextWeekdayDate(targetDate, 1);
    targetDate.setDate(targetDate.getDate() + 7);
  } else if (weekdayMap[day]) {
    targetDate = nextWeekdayDate(targetDate, weekdayMap[day]);
  } else {
    // If they said Sat/Sun or something weird, push to next weekday
    targetDate.setDate(targetDate.getDate() + 1);
    targetDate = clampToMonFri(targetDate);
  }

  // If they chose Saturday/Sunday, force Monday
  targetDate = clampToMonFri(targetDate);

  const slots = slotTimesForWindow(win);
  const idx = pickSlotIndex(stableKey);
  const chosen = slots[idx] || slots[0];

  targetDate.setHours(chosen.h, chosen.m, 0, 0);
  return formatInLondon(targetDate);
}

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
  session.booking = { preferred_day: "", preferred_window: "", confirmed_address: "", notes: "", start_datetime: "" };

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
app.post("/twilio/speech", async (req, res) => {
  const baseUrl = process.env.PUBLIC_BASE_URL;
  const callSid = req.body.CallSid;
  const speech = (req.body.SpeechResult || "").trim();
  const confidence = req.body.Confidence;

  const session = ensureSession(callSid);
  session.turns = (session.turns || 0) + 1;

  if (speech) session.transcript.push({ role: "user", text: speech });

  console.log("Speech:", { callSid, speech, confidence, stage: session.stage });

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

  const filler = pick([
    "Mm-hmm… one sec.",
    "Okay… just checking that.",
    "Perfect… just a moment.",
    "Right… bear with me a sec.",
    "System’s being a bit slow… one moment."
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

  if (!session.lead || !session.lead.phone) {
    const twimlOops = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${ttsUrl(baseUrl, "Sorry — I’ve lost the details on my side. I’ll send you a text to book in. Bye for now.")}</Play>
  <Hangup/>
</Response>`;
    return res.type("text/xml").send(twimlOops);
  }

  const lastUser = [...session.transcript].reverse().find((t) => t.role === "user")?.text || "";

  let reply = "";
  let shouldHangup = false;

  // OPEN -> CONFIRM_ADDRESS
  if (session.stage === "OPEN") {
    if (isNo(lastUser)) {
      reply = "No problem at all. I’ll send you a quick text and you can pick a time that suits. Bye for now.";
      shouldHangup = true;
      session.stage = "DONE";
    } else {
      session.stage = "CONFIRM_ADDRESS";
    }
  }

  // CONFIRM_ADDRESS (confirm what’s on the form; don’t re-ask full address)
  if (session.stage === "CONFIRM_ADDRESS") {
    const hasAddress = !!norm(session.lead.address);
    const hasPostcode = !!norm(session.lead.postcode);

    if (hasAddress || hasPostcode) {
      const addrLine = [session.lead.address, session.lead.postcode].filter(Boolean).join(", ");

      if (session.retries.confirmAddress === 0) {
        reply = `Perfect. I’ve got the survey address as ${addrLine}. Is that correct?`;
        session.retries.confirmAddress++;
      } else {
        if (isYes(lastUser)) {
          session.booking.confirmed_address = addrLine;
          session.stage = "ASK_DAY";
        } else if (isNo(lastUser)) {
          reply = "No worries — what’s the correct postcode for the survey address?";
          session.retries.confirmAddress++;
          session.booking.notes = (session.booking.notes || "") + " Address mismatch reported.";
        } else {
          // treat postcode-like input as postcode
          const maybe = lastUser.trim();
          if (maybe.length >= 5 && /[a-z]/i.test(maybe) && /\d/.test(maybe)) {
            session.lead.postcode = maybe;
            session.booking.confirmed_address = [session.lead.address, session.lead.postcode].filter(Boolean).join(", ");
            session.stage = "ASK_DAY";
          } else {
            reply = "Sorry — just to confirm, is that address correct?";
            session.retries.confirmAddress++;
          }
        }

        if (session.retries.confirmAddress >= 4 && session.stage === "CONFIRM_ADDRESS") {
          reply = "No worries — I’ll send you a text to confirm the address and get you booked in. Bye for now.";
          shouldHangup = true;
          session.stage = "DONE";
        }
      }
    } else {
      if (session.retries.confirmAddress === 0) {
        reply = "Quick one — what’s the postcode for the survey address?";
        session.retries.confirmAddress++;
      } else {
        const maybe = lastUser.trim();
        if (maybe.length >= 5) {
          session.lead.postcode = maybe;
          session.booking.confirmed_address = session.lead.postcode;
          session.stage = "ASK_DAY";
        } else {
          reply = "Sorry — what’s the postcode there?";
          session.retries.confirmAddress++;
        }
      }
    }
  }

  // ASK_DAY (Mon–Fri only)
  if (session.stage === "ASK_DAY") {
    const day = extractDay(lastUser);

    if (!day) {
      if (session.retries.askDay === 0) {
        reply = "Lovely. What day suits you best for the survey? We do Monday to Friday.";
        session.retries.askDay++;
      } else {
        reply = "No worries — is that more like Monday, Tuesday, or later in the week?";
        session.retries.askDay++;
      }

      if (session.retries.askDay >= 4) {
        reply = "No problem — I’ll text you a link to pick a day that suits. Bye for now.";
        shouldHangup = true;
        session.stage = "DONE";
      }
    } else {
      // If they said Sat/Sun, push back to weekday
      if (day === "Saturday" || day === "Sunday") {
        reply = "We’re Monday to Friday for surveys — which weekday would suit you best?";
        session.retries.askDay++;
      } else {
        session.booking.preferred_day = day;
        session.stage = "ASK_WINDOW";
      }
    }
  }

  // ASK_WINDOW (Morning/Afternoon only)
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
    } else if (win === "Evening") {
      reply = "We don’t do evenings for surveys — would morning or afternoon suit better?";
      session.retries.askWindow++;
    } else {
      session.booking.preferred_window = win;

      // ✅ compute actual datetime for GHL booking
      session.booking.start_datetime = computeStartDateTime(
        session.booking.preferred_day,
        session.booking.preferred_window,
        callSid
      );

      session.stage = "CONFIRM_CLOSE";
    }
  }

  // CONFIRM_CLOSE -> post to GHL
  if (session.stage === "CONFIRM_CLOSE") {
    try {
      await postToGhlBookingWebhook({
        lead: session.lead,
        booking: session.booking,
        transcript: session.transcript
      });
    } catch (e) {
      console.error("GHL webhook post failed:", e?.message || e);
    }

    reply = `Perfect. I’ve got you down for ${session.booking.preferred_day} ${session.booking.preferred_window}. I’ll send you a text or email confirmation, and if you need to change it you can just reply. Thanks so much — bye for now.`;
    shouldHangup = true;
    session.stage = "DONE";
  }

  // fallback replies
  if (!reply && session.stage === "ASK_DAY") reply = "What day suits you best for the survey? Monday to Friday.";
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

  // ✅ IMPORTANT: match your workflow mapping: inboundWebhookRequest.lead.xxx and inboundWebhookRequest.booking.xxx
  const payload = {
    agent: "Nicola",
    source: "AI_CALL",
    intent: "BOOK",
    lead: {
      phone: lead?.phone || "",
      name: lead?.name || "",
      email: lead?.email || "",
      address: lead?.address || "",
      postcode: lead?.postcode || "",
      propertyType: lead?.propertyType || "",
      isHomeowner: lead?.isHomeowner || ""
    },
    booking: {
      preferred_day: booking?.preferred_day || "",
      preferred_window: booking?.preferred_window || "",
      confirmed_address: booking?.confirmed_address || "",
      notes: booking?.notes || "",
      start_datetime: booking?.start_datetime || "" // ✅ used by Book Appointment
    },
    transcript: transcript.map((t) => `${t.role === "assistant" ? "Nicola" : "Lead"}: ${t.text}`).join("\n")
  };

  console.log("Posting booking payload to GHL:", payload.booking, payload.lead);

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
