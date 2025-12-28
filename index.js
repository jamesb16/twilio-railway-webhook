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
 *   turns: number
 * }
 */
const sessions = new Map();

// Small in-memory cache for TTS buffers (helps a bit with repeat phrases)
const ttsCache = new Map();
const TTS_CACHE_MAX = 200;

function cacheSet(key, val) {
  if (ttsCache.size >= TTS_CACHE_MAX) {
    // delete oldest
    const firstKey = ttsCache.keys().next().value;
    if (firstKey) ttsCache.delete(firstKey);
  }
  ttsCache.set(key, val);
}

function pickFirst(...vals) {
  for (const v of vals) {
    if (v === undefined || v === null) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return "";
}

function asYesNo(v) {
  const s = String(v || "").trim().toLowerCase();
  if (!s) return "";
  if (["true", "yes", "y", "yeah", "yeh", "yep", "aye", "i am", "correct"].some(x => s === x)) return "Yes";
  if (["false", "no", "n", "nah", "nope", "not"].some(x => s === x)) return "No";
  // Sometimes comes through as "Yes " / "No " etc
  if (s.includes("yes")) return "Yes";
  if (s.includes("no")) return "No";
  return String(v).trim();
}

function normalizePhone(p) {
  if (!p) return "";
  return String(p).trim();
}

function looksLikeHomeownerQuestion(text) {
  return /home\s*owner|homeowner|own the property|are you the owner/i.test(text || "");
}

// -------------------- Health --------------------
app.get("/", (req, res) => res.status(200).send("OK - Greenbug outbound AI is running"));
app.get("/health", (req, res) => res.status(200).json({ ok: true }));

// Optional helper: send a test payload into your GHL booking trigger (useful for mapping reference)
app.get("/send-test-to-ghl", async (req, res) => {
  try {
    await postToGhlBookingWebhook({
      lead: {
        name: "Test Lead",
        phone: "+447700900000",
        email: "test@example.com",
        address: "1 Test Street",
        postcode: "G1 1AA",
        propertyType: "Detached",
        isHomeowner: "Yes"
      },
      booking: { preferred_day: "next week", preferred_window: "afternoon", notes: "Test mapping reference payload" },
      transcript: [{ role: "assistant", text: "Lead: I'd like solar." }, { role: "user", text: "Nicola: Great, I’ll book a survey." }]
    });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// -------------------- Trigger outbound call from GHL --------------------
app.post("/ghl/lead", async (req, res) => {
  try {
    const body = req.body || {};

    // GHL payloads vary wildly. Try common containers first:
    const leadObj =
      body.lead ||
      body.contact ||
      body.inboundWebhookRequest?.lead ||
      body.inboundWebhookRequest?.contact ||
      body.data?.lead ||
      body.data?.contact ||
      body;

    const phoneRaw = pickFirst(
      leadObj.phone,
      leadObj.Phone,
      leadObj.phoneNumber,
      leadObj.phone_number,
      body.phone,
      body.Phone
    );

    const name = pickFirst(
      leadObj.name,
      leadObj.full_name,
      leadObj.fullName,
      body.name,
      body.full_name,
      [leadObj.firstName, leadObj.lastName].filter(Boolean).join(" "),
      [leadObj.first_name, leadObj.last_name].filter(Boolean).join(" "),
      "there"
    );

    const email = pickFirst(leadObj.email, leadObj.Email, leadObj.emailAddress, body.email, body.Email);

    const address = pickFirst(
      leadObj.address,
      leadObj.Address,
      leadObj.address1,
      leadObj.street,
      body.address,
      body.Address
    );

    const postcode = pickFirst(
      leadObj.postcode,
      leadObj.postCode,
      leadObj.Postcode,
      leadObj.postalCode,
      leadObj.postal_code,
      body.postcode,
      body.postCode,
      body.Postcode
    );

    const propertyType = pickFirst(
      leadObj.propertyType,
      leadObj.property_type,
      leadObj["Property Type"],
      leadObj.property,
      body.propertyType,
      body["Property Type"]
    );

    // Homeowner often comes through under different keys
    const homeownerRaw = pickFirst(
      leadObj.isHomeowner,
      leadObj.homeowner,
      leadObj["Are You The Homeowner"],
      leadObj["Are you the homeowner"],
      leadObj.areYouTheHomeowner,
      leadObj.are_you_the_homeowner,
      body.isHomeowner,
      body.homeowner,
      body["Are You The Homeowner"]
    );
    const isHomeowner = asYesNo(homeownerRaw);

    const to = normalizePhone(phoneRaw);
    if (!to) return res.status(400).json({ ok: false, error: "Missing phone in webhook payload" });

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
      )}&email=${encodeURIComponent(email)}&address=${encodeURIComponent(address)}&postcode=${encodeURIComponent(
        postcode
      )}&propertyType=${encodeURIComponent(propertyType)}&isHomeowner=${encodeURIComponent(isHomeowner)}`,
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
      name,
      extracted: { email, address, postcode, propertyType, isHomeowner }
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
    turns: 0
  });

  const opening = `Hi ${name}. It’s Nicola from Greenbug Energy. You just requested a free home energy survey about solar panels — have I caught you at an okay time?`;

  // Hints help recognition of UK “yes” variants
  const hints = "yes,yeah,yeh,yep,aye,no,nah,nope,now,later,busy,call back";

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${baseUrl}/tts?text=${encodeURIComponent(opening)}</Play>
  <Gather input="speech" language="en-GB" hints="${hints}" action="${baseUrl}/twilio/speech" method="POST" speechTimeout="1" timeout="5"/>
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

  console.log("Speech:", { callSid, speech, confidence, lead: session.lead });

  // Safety stop
  if (session.turns >= 12) {
    const bye = "Thanks — I’ll send you a quick text and we can take it from there. Bye for now.";
    const twimlEnd = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${baseUrl}/tts?text=${encodeURIComponent(bye)}</Play>
  <Hangup/>
</Response>`;
    sessions.set(callSid, session);
    return res.type("text/xml").send(twimlEnd);
  }

  const ai = await getAiTurn({
    lead: session.lead,
    transcript: session.transcript
  });

  // If homeowner already known, do NOT allow the AI to keep asking it
  if (session.lead?.isHomeowner && looksLikeHomeownerQuestion(ai.reply)) {
    const p = session.lead.postcode ? `the postcode is still ${session.lead.postcode}` : "your postcode";
    ai.reply = `Perfect — I’ve already got that noted from the form, so I won’t bore you with it 😊 Quick one: can you just confirm ${p}?`;
    ai.intent = "CONTINUE";
    ai.end_state = "CONTINUE";
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

  const hints = "yes,yeah,yeh,yep,aye,no,nah,nope,morning,afternoon,next week,weekday,weekend,busy,call back";

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${baseUrl}/tts?text=${encodeURIComponent(ai.reply)}</Play>
  ${
    shouldHangup
      ? "<Hangup/>"
      : `<Gather input="speech" language="en-GB" hints="${hints}" action="${baseUrl}/twilio/speech" method="POST" speechTimeout="1" timeout="6"/>`
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

    // Serve from cache if we can (helps the “repeat” bits)
    const cacheKey = text;
    const cached = ttsCache.get(cacheKey);
    if (cached) {
      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).send(cached);
    }

    if (!process.env.ELEVENLABS_API_KEY || !process.env.ELEVENLABS_VOICE_ID) {
      // Return short silence instead of crashing the call
      res.setHeader("Content-Type", "audio/mpeg");
      return res.status(200).send(Buffer.alloc(8));
    }

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
      // Return silence so Twilio doesn’t throw “application error”
      res.setHeader("Content-Type", "audio/mpeg");
      return res.status(200).send(Buffer.alloc(8));
    }

    const audio = Buffer.from(await r.arrayBuffer());
    cacheSet(cacheKey, audio);

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).send(audio);
  } catch (e) {
    console.error("TTS error:", e);
    res.setHeader("Content-Type", "audio/mpeg");
    return res.status(200).send(Buffer.alloc(8));
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
      end_state: "LATER_DONE"
    };
  }

  const leadSummary = {
    name: lead?.name || "",
    phone: lead?.phone || "",
    email: lead?.email || "",
    address: lead?.address || "",
    postcode: lead?.postcode || "",
    propertyType: lead?.propertyType || "",
    isHomeowner: lead?.isHomeowner || ""
  };

  const system = `
You are "Nicola", a friendly UK caller for Greenbug Energy.
Context: You are calling a lead who filled a form requesting a FREE home energy survey about solar panels.
Goal: Have a natural conversation and get them booked for a site survey.

Rules:
- Sound human, warm, short sentences. UK tone. No robotic scripts.
- It’s okay to use tiny fillers sometimes: "mm-hmm", "okay", "got it".
- Ask ONE question at a time.
- IMPORTANT: If isHomeowner is already provided in the form data, DO NOT ask the homeowner question again. Treat it as known and move on.
- Confirm the ADDRESS only if missing/unclear. If already provided, just confirm postcode.
- Qualify lightly: property type, approx monthly electric bill, roof shading, timeframe to install.
- If they are busy: offer to text and book later. If not interested: be polite and end.
- To BOOK: ask for preferred day and whether morning/afternoon. Do NOT promise an exact time. Say you’ll text confirmation.
- Output MUST be valid JSON only with keys: reply, intent, end_state, booking
- intent must be one of: CONTINUE, BOOK, LATER, NOT_INTERESTED
- end_state must be one of: CONTINUE, BOOKED_DONE, LATER_DONE, NOT_INTERESTED
- booking is an object and may include: preferred_day, preferred_window, notes, confirmed_address
`;

  const messages = [
    { role: "system", content: system.trim() },
    { role: "user", content: `Form data (treat as truth if present): ${JSON.stringify(leadSummary)}` },
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
      temperature: 0.3,
      max_tokens: 220,
      messages
    })
  });

  const data = await resp.json();
  const raw = data?.choices?.[0]?.message?.content || "";

  try {
    const parsed = JSON.parse(raw);
    if (!parsed.reply) throw new Error("No reply");
    return {
      reply: String(parsed.reply),
      intent: parsed.intent || "CONTINUE",
      end_state: parsed.end_state || "CONTINUE",
      booking: parsed.booking || {}
    };
  } catch (e) {
    // IMPORTANT: fallback should NOT keep asking homeowner if already known
    const fallback =
      lead?.isHomeowner
        ? (lead?.postcode ? `Lovely — just to confirm, is the postcode still ${lead.postcode}?` : "Lovely — can you confirm your postcode for me?")
        : "Perfect — just a quick one: are you the homeowner at the property?";
    return { reply: fallback, intent: "CONTINUE", end_state: "CONTINUE", booking: {} };
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
