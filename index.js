const express = require("express");

const app = express();

// Twilio will POST form-encoded data by default
app.use(express.urlencoded({ extended: false }));

// ✅ Root route so your Railway URL actually shows something in a browser
app.get("/", (req, res) => {
  res.status(200).send("OK - Railway Node server is running");
});

// ✅ Health endpoint (use this to test quickly)
app.get("/health", (req, res) => {
  res.status(200).json({ ok: true });
});

// ✅ Twilio Voice Webhook (returns TwiML)
app.post("/twilio/voice", (req, res) => {
  res.type("text/xml");
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Hello. Your Twilio webhook on Railway is working.</Say>
</Response>`);
});

// ✅ MUST listen on Railway's provided PORT
const PORT = process.env.PORT || 3000;

// ✅ Bind to 0.0.0.0 for cloud platforms
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Listening on ${PORT}`);
});
