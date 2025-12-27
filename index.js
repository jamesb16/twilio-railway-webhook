const express = require("express");

const app = express();

// Twilio sends application/x-www-form-urlencoded by default
app.use(express.urlencoded({ extended: false }));

// Root – so Railway URL doesn't look dead
app.get("/", (req, res) => {
  res.status(200).send("OK");
});

// Health check
app.get("/health", (req, res) => {
  res.status(200).json({ ok: true });
});

// Twilio Voice Webhook
app.post("/voice", (req, res) => {
  res.set("Content-Type", "text/xml");
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice" language="en-GB">
    Hello. Your Twilio webhook is working.
  </Say>
</Response>`);
});

// 🚨 THIS IS THE IMPORTANT PART 🚨
// Railway injects PORT at runtime
const PORT = process.env.PORT;

if (!PORT) {
  console.error("PORT environment variable not set");
  process.exit(1);
}

// Bind to all interfaces so Railway can reach it
app.listen(PORT, "0.0.0.0", () => {
  console.log("Listening on", PORT);
});
