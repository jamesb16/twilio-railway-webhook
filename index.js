const express = require("express");

const app = express();

// Twilio sends x-www-form-urlencoded by default
app.use(express.urlencoded({ extended: false }));

// Root (so visiting the Railway URL shows something)
app.get("/", (req, res) => {
  res.status(200).send("OK - Railway Node server is running");
});

// Health check
app.get("/health", (req, res) => {
  res.status(200).json({ ok: true });
});

// Twilio Voice webhook (returns TwiML)
app.post("/twilio/voice", (req, res) => {
  res.type("text/xml");
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Hello. Your Twilio webhook on Railway is working.</Say>
</Response>`);
});

// IMPORTANT: listen on Railway's provided PORT (often 8080)
const PORT = process.env.PORT || 3000;

// IMPORTANT: bind 0.0.0.0 on cloud platforms
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Listening on ${PORT}`);
});
