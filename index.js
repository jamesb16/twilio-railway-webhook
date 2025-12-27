const express = require("express");

const app = express();

// Twilio posts form-encoded by default
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// IMPORTANT: Railway sets PORT. Do NOT hardcode 8080.
const PORT = process.env.PORT || 3000;

// Health check
app.get("/health", (req, res) => {
  res.status(200).json({ ok: true });
});

// Twilio voice webhook (returns TwiML)
app.post("/voice", (req, res) => {
  res
    .type("text/xml")
    .send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Hello. This is a Twilio test call from Railway.</Say>
</Response>`);
});

// Root (optional but handy)
app.get("/", (req, res) => {
  res.status(200).send("OK");
});

// MUST listen on 0.0.0.0 for hosted platforms
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Listening on ${PORT}`);
});
