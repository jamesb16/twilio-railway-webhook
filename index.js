require("dotenv").config();
const express = require("express");
const twilio = require("twilio");

const app = express();

// Twilio + GHL can send x-www-form-urlencoded OR JSON depending on config
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ====== ENV ======
const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_FROM_NUMBER,
  BASE_URL
} = process.env;

if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM_NUMBER || !BASE_URL) {
  console.warn("Missing env vars. Required: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER, BASE_URL");
}

const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// VERY simple in-memory store (fine for testing)
const LEADS = new Map(); // leadId -> { phone, name, createdAt, outcome, callSid }

// Root + health
app.get("/", (req, res) => res.status(200).send("OK - Railway Node server is running"));
app.get("/health", (req, res) => res.status(200).json({ ok: true }));

/**
 * 1) GHL -> POST /ghl/lead
 * Store the lead and (optionally) trigger the call immediately.
 * In your workflow you can do:
 * Trigger -> Wait 2 mins -> Webhook to /ghl/lead?call=1
 * OR:
 * Webhook first (call=0) -> Wait 2 mins -> Webhook to /call (see below)
 */
app.post("/ghl/lead", async (req, res) => {
  try {
    const body = req.body || {};

    // GHL fields vary, so we defensively pick common ones:
    const phone =
      body.phone ||
      body.Phone ||
      body.contact?.phone ||
      body.contact?.phone_number ||
      body.contact?.phoneNumber;

    const name =
      body.full_name ||
      body.fullName ||
      body.name ||
      body.contact?.name ||
      `${body.first_name || ""} ${body.last_name || ""}`.trim();

    if (!phone) {
      return res.status(400).json({ ok: false, error: "No phone found in webhook payload" });
    }

    const leadId = `${Date.now()}_${Math.random().toString(16).slice(2)}`;

    LEADS.set(leadId, {
      phone,
      name: name || "there",
      createdAt: new Date().toISOString(),
      outcome: "NEW"
    });

    // Reply quickly to GHL
    res.status(200).json({ ok: true, leadId });

    // If you want THIS webhook to initiate calling, add ?call=1
    const shouldCall = String(req.query.call || "0") === "1";
    if (shouldCall) {
      await startOutboundCall(leadId);
    }
  } catch (e) {
    console.error("GHL webhook error:", e);
    res.status(500).json({ ok: false });
  }
});

/**
 * 2) Tr*
