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
 *   stage:
 *     "OPEN"|"CONFIRM_ADDRESS"|"ASK_DAY"|"ASK_WINDOW"|"CONFIRM_SLOT"|"CONFIRM_CLOSE"|"DONE",
 *   retries: { confirmAddress: number, askDay: number, askWindow: number, confirmSlot: number },
 *   booking: {
 *     preferred_day, preferred_window, confirmed_address, notes,
 *     start_datetime, slot_date_iso, slot_time_24h
 *   },
 *   offered: { dayLabel, window, start_datetime, slot_date_iso, slot_time_24h }
 * }
 */
const sessions = new Map();

// Basic “don’t call them 5 times” dedupe: key -> lastCalledAt
const recentCalls = new Map();
const DEDUPE_MS = 5 * 60 * 1000; // 5 minutes

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
    t.includes("that works") ||
    t.includes("works") ||
    t.includes("perfect")
  );
}

function isNo(s) {
  const t = norm(s);
  return (
    t === "no" ||
    t === "nope" ||
    t === "nah" ||
    t === "not really" ||
    (t.includes("no") && !t.includes("know")) ||
    t.includes("not") ||
    t.includes("wrong") ||
    t.includes("incorrect") ||
    t.includes("can't") ||
    t.includes("cannot")
  );
}

function extractWindow(s) {
  const t = norm(s);
  if (t.includes("morning") || t.includes("am") || t.includes("a.m")) return "Morning";
  if (t.includes("afternoon") || t.includes("pm") || t.includes("p.m")) return "Afternoon";
  if (t.includes("evening")) return "Evening"; // we won't offer it, but we can parse it.
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
      retries: { confirmAddress: 0, askDay: 0, askWindow: 0, confirmSlot: 0 },
      booking: {
        preferred_day: "",
        preferred_window: "",
        confirmed_address: "",
        notes: "",
        start_datetime: "",
        slot_date_iso: "",
        slot_time_24h: ""
      },
      offered: null
    });
  }
  return sessions.get(callSid);
}

// -------------------- Calendar rules (Mon–Fri only, fixed daily slots) --------------------
// Slots (UK local): morning 09:30 + 11:30, afternoon 13:30 + 15:00
const FIXED_SLOTS = {
  Morning: ["09:30", "11:30"],
  Afternoon: ["13:30", "15:00"]
};

// in-memory “booked slots” registry (so we can offer another slot if taken)
// bookedSlots[YYYY-MM-DD] = Set(["09:30","11:30",...])
const bookedSlots = new Map();

function pad2(n) {
  return String(n).padStart(2, "0");
}

// Format for your GHL “Book Appointment” text box (what you pasted): "DD-MMM-YYYY HH:MM AM"
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function formatGhlDateFromParts({ year, monthIndex, day, hour24, minute }) {
  const dd = pad2(day);
  const mmm = MONTHS[monthIndex];
  const yyyy = year;

  let hours = hour24;
  const minutes = pad2(minute);
  const ampm = hours >= 12 ? "PM" : "AM";
  hours = hours % 12;
  if (hours === 0) hours = 12;

  return `${dd}-${mmm}-${yyyy} ${pad2(hours)}:${minutes} ${ampm}`;
}

function isWeekendYMD(y, mIndex, d) {
  // Use UTC to keep consistent on Railway
  const dow = new Date(Date.UTC(y, mIndex, d)).getUTCDay(); // 0 Sun ... 6 Sat
  return dow === 0 || dow === 6;
}

// Move date forward until it’s Mon–Fri
function forceWeekdayYMD(y, mIndex, d) {
  let yy = y, mm = mIndex, dd = d;
  while (isWeekendYMD(yy, mm, dd)) {
    const dt = new Date(Date.UTC(yy, mm, dd));
    dt.setUTCDate(dt.getUTCDate() + 1);
    yy = dt.getUTCFullYear();
    mm = dt.getUTCMonth();
    dd = dt.getUTCDate();
  }
  return { y: yy, mIndex: mm, d: dd };
}

function nextDateForPreferredDay(preferredDay) {
  const now = new Date(); // server time (UTC-ish)
  let dt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  dt.setUTCSeconds(0, 0);

  if (preferredDay === "Tomorrow") {
    dt.setUTCDate(dt.getUTCDate() + 1);
    return dt;
  }

  if (preferredDay === "Next week") {
    // next Monday (guaranteed next week)
    const current = dt.getUTCDay();
    const target = 1; // Monday
    let add = (target - current + 7) % 7;
    if (add === 0) add = 7;
    add += 7;
    dt.setUTCDate(dt.getUTCDate() + add);
    return dt;
  }

  const week = { Sunday:0, Monday:1, Tuesday:2, Wednesday:3, Thursday:4, Friday:5, Saturday:6 };
  if (week[preferredDay] !== undefined) {
    const target = week[preferredDay];
    const current = dt.getUTCDay();
    let add = (target - current + 7) % 7;

    // allow “today” if they picked today’s weekday (keeps day accurate)
    // but if you want “never same day”, change to: if (add === 0) add = 7;
    // Here: keep add = 0.
    dt.setUTCDate(dt.getUTCDate() + add);
    return dt;
  }

  dt.setUTCDate(dt.getUTCDate() + 1);
  return dt;
}

function ymdISO(y, mIndex, d) {
  return `${y}-${pad2(mIndex + 1)}-${pad2(d)}`;
}

function reserveSlot(dateISO, time24h) {
  if (!bookedSlots.has(dateISO)) bookedSlots.set(dateISO, new Set());
  bookedSlots.get(dateISO).add(time24h);
}

function isSlotTaken(dateISO, time24h) {
  return bookedSlots.has(dateISO) && bookedSlots.get(dateISO).has(time24h);
}

// Find next available slot based on (preferred_day + preferred_window).
// If none available that day/window, it will try:
// 1) next weekday same window
// 2) next weekday other window
function findNextAvailableSlot(preferredDay, preferredWindow, maxSearchDays = 14) {
  const prefDay = String(preferredDay || "").trim();
  const prefWin = String(preferredWindow || "").trim();

  const windowsToTry = [];
  if (prefWin === "Morning" || prefWin === "Afternoon") {
    windowsToTry.push(prefWin);
  }
  // after trying preferred window, allow the other one
  windowsToTry.push(prefWin === "Morning" ? "Afternoon" : "Morning");

  // Start date = next date for preferred day (then force weekday)
  const startDT = nextDateForPreferredDay(prefDay);
  let y = startDT.getUTCFullYear();
  let mIndex = startDT.getUTCMonth();
  let d = startDT.getUTCDate();
  ({ y, mIndex, d } = forceWeekdayYMD(y, mIndex, d));

  // iterate day by day up to maxSearchDays
  for (let offset = 0; offset <= maxSearchDays; offset++) {
    const dt = new Date(Date.UTC(y, mIndex, d));
    dt.setUTCDate(dt.getUTCDate() + offset);
    let yy = dt.getUTCFullYear();
    let mm = dt.getUTCMonth();
    let dd = dt.getUTCDate();

    // skip weekends
    if (isWeekendYMD(yy, mm, dd)) continue;

    const dateISO = ymdISO(yy, mm, dd);

    for (const win of windowsToTry) {
      for (const t24 of FIXED_SLOTS[win]) {
        if (!isSlotTaken(dateISO, t24)) {
          const [hh, mi] = t24.split(":").map((x) => parseInt(x, 10));
          const ghl = formatGhlDateFromParts({
            year: yy,
            monthIndex: mm,
            day: dd,
            hour24: hh,
            minute: mi
          });

          // Friendly spoken label
          const spokenTime = t24; // "09:30" is fine to speak
          // Get weekday name
          const weekdayName = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"][
            new Date(Date.UTC(yy, mm, dd)).getUTCDay()
          ];

          return {
            dateISO,
            time24h: t24,
            window: win,
            start_datetime: ghl,
            spoken: `${weekdayName} at ${spokenTime}`
          };
        }
      }
    }
  }

  return null;
}

// -------------------- Health --------------------
app.get("/", (req, res) => res.status(200).send("OK - Greenbug outbound AI is running"));
app.get("/health", (req, res) => res.status(200).json({ ok: true }));

// -------------------- TEST: Send fake booking payload to GHL --------------------
app.post("/send-test-to-ghl", async (req, res) => {
  try {
    await postToGhlBookingWebhook({
      lead: {
        name: "Test Lead",
        phone: "+447700900123",
        email: "test@example.com",
        address: "1 Test Street",
        postcode: "G1 1AA",
        propertyType: "House",
        isHomeowner: "Yes"
      },
      booking: {
        preferred_day: "Monday",
        preferred_window: "Morning",
        confirmed_address: "1 Test Street, G1 1AA",
        notes: "Test booking from /send-test-to-ghl",
        start_datetime: formatGhlDateFromParts({
          year: new Date().getUTCFullYear(),
          monthIndex: new Date().getUTCMonth(),
          day: new Date().getUTCDate(),
          hour24: 9,
          minute: 30
        })
      },
      transcript: [{ role: "assistant", text: "Test transcript" }]
    });

    return res.json({ ok: true, message: "Test payload posted to GHL_BOOKING_TRIGGER_URL" });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

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

    // ---- Dedupe so the workflow doesn’t call them 5 times ----
    const dedupeKey = `${to}|${String(email || "").trim().toLowerCase()}|${String(name || "").trim().toLowerCase()}`;
    const last = recentCalls.get(dedupeKey);
    const now = Date.now();
    if (last && now - last < DEDUPE_MS) {
      return res.status(200).json({ ok: true, skipped: true, reason: "Deduped (recent call)", to, name });
    }
    recentCalls.set(dedupeKey, now);

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
  session.retries = { confirmAddress: 0, askDay: 0, askWindow: 0, confirmSlot: 0 };
  session.booking = {
    preferred_day: "",
    preferred_window: "",
    confirmed_address: "",
    notes: "",
    start_datetime: "",
    slot_date_iso: "",
    slot_time_24h: ""
  };
  session.offered = null;

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
// IMPORTANT: returns immediately with filler + redirect, to reduce “dead air”
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
  if (session.turns >= 18) {
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
    "Got it… just pulling that up."
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

  // CONFIRM_ADDRESS (confirm what we already have, don’t re-ask the whole thing)
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
          // Treat postcode-like answer as postcode
          const maybe = lastUser.trim();
          if (maybe.length >= 5 && /[a-z]/i.test(maybe) && /\d/.test(maybe)) {
            session.lead.postcode = maybe;
            session.booking.confirmed_address = [session.lead.address, session.lead.postcode]
              .filter(Boolean)
              .join(", ");
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
      // no address at all, collect postcode
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
        reply = "Lovely. What day suits you best for the survey? Monday to Friday.";
        session.retries.askDay++;
      } else {
        reply = "No worries — is that more like Monday, Tuesday, or later in the week? Monday to Friday only.";
        session.retries.askDay++;
      }

      if (session.retries.askDay >= 4) {
        reply = "No problem — I’ll text you a link to pick a day that suits. Bye for now.";
        shouldHangup = true;
        session.stage = "DONE";
      }
    } else {
      if (day === "Saturday" || day === "Sunday") {
        reply = "We’re Monday to Friday for surveys — which weekday suits best?";
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

    if (!win || win === "Evening") {
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

      // Find an actual available slot (fixed times)
      const slot = findNextAvailableSlot(session.booking.preferred_day, session.booking.preferred_window);

      if (!slot) {
        reply = "I’m really sorry — we’re fully booked over the next couple of weeks. I’ll send you a text so you can pick another time. Bye for now.";
        shouldHangup = true;
        session.stage = "DONE";
      } else {
        // If the slot isn’t on their exact asked day (or their day is already full), we offer it verbally
        session.offered = {
          dayLabel: slot.spoken.split(" at ")[0], // e.g. "Tuesday"
          window: slot.window,
          start_datetime: slot.start_datetime,
          slot_date_iso: slot.dateISO,
          slot_time_24h: slot.time24h,
          spoken: slot.spoken
        };

        // Ask confirmation of offered slot
        reply = `Perfect. I can do ${slot.spoken}. Does that work for you?`;
        session.stage = "CONFIRM_SLOT";
        session.retries.confirmSlot = 0;
      }
    }
  }

  // CONFIRM_SLOT (YES = reserve + proceed, NO = ask day again)
  if (session.stage === "CONFIRM_SLOT") {
    if (isYes(lastUser)) {
      // Reserve it in-memory (prevents offering same slot twice in back-to-back tests)
      reserveSlot(session.offered.slot_date_iso, session.offered.slot_time_24h);

      // Commit booking fields
      session.booking.start_datetime = session.offered.start_datetime;
      session.booking.slot_date_iso = session.offered.slot_date_iso;
      session.booking.slot_time_24h = session.offered.slot_time_24h;
      session.booking.preferred_window = session.offered.window;
      // keep preferred_day as what they originally said, but add note of actual slot:
      session.booking.notes = (session.booking.notes || "") + ` Scheduled slot: ${session.offered.spoken}.`;

      session.stage = "CONFIRM_CLOSE";
    } else if (isNo(lastUser)) {
      reply = "No problem. What day suits you best instead? Monday to Friday.";
      session.stage = "ASK_DAY";
      session.retries.askDay = 0;
      session.retries.askWindow = 0;
      session.offered = null;
    } else {
      // didn’t catch yes/no
      session.retries.confirmSlot++;
      if (session.retries.confirmSlot >= 3) {
        reply = "No worries — I’ll send you a text to pick the best time. Bye for now.";
        shouldHangup = true;
        session.stage = "DONE";
      } else {
        reply = `Sorry — just to confirm, does ${session.offered?.spoken || "that time"} work for you?`;
      }
    }
  }

  // CONFIRM_CLOSE -> post to GHL webhook once and end
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

    reply =
      "Perfect. I’ll send you a text or email confirmation just now — and if you need to change it, you can just reply. Thanks so much — bye for now.";
    shouldHangup = true;
    session.stage = "DONE";
  }

  // fallback replies
  if (!reply && session.stage === "ASK_DAY") reply = "What weekday suits you best for the survey? Monday to Friday.";
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

  // IMPORTANT: wrap in {lead:{...}} so your GHL mappings inboundWebhookRequest.lead.xxx work
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
      // THIS is what your GHL “Book Appointment” step should read:
      start_datetime: booking?.start_datetime || "",
      // Extra debug fields (harmless if you ignore them in GHL)
      slot_date_iso: booking?.slot_date_iso || "",
      slot_time_24h: booking?.slot_time_24h || ""
    },

    transcript: transcript
      .map((t) => `${t.role === "assistant" ? "Nicola" : "Lead"}: ${t.text}`)
      .join("\n")
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
