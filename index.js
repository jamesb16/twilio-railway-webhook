// Pick 2 fixed slots per window
function pickSlotTime(win, slotIndex) {
  // slotIndex: 0 or 1
  if (win === "Afternoon") {
    // 2:00pm or 3:30pm
    return slotIndex === 0 ? { h: 14, m: 0 } : { h: 15, m: 30 };
  }
  // Morning default: 10:00am or 11:30am
  return slotIndex === 0 ? { h: 10, m: 0 } : { h: 11, m: 30 };
}

// Simple in-memory counter per date+window (works as long as Railway stays up)
const slotCounters = new Map();

function computeStartDateTime(preferredDay, preferredWindow) {
  let d = nextDateForPreferredDay(String(preferredDay || "").trim());
  d = forceWeekday(d);

  const win = String(preferredWindow || "").trim() || "Morning";

  // Key by YYYY-MM-DD + window
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const key = `${y}-${m}-${day}-${win}`;

  const used = slotCounters.get(key) || 0;

  // Only allow 2 per window per day.
  // If already 2 used, push to next weekday and reset counter for that new day.
  if (used >= 2) {
    d.setDate(d.getDate() + 1);
    d = forceWeekday(d);

    const y2 = d.getFullYear();
    const m2 = String(d.getMonth() + 1).padStart(2, "0");
    const day2 = String(d.getDate()).padStart(2, "0");
    const key2 = `${y2}-${m2}-${day2}-${win}`;

    slotCounters.set(key2, 1);
    const t = pickSlotTime(win, 0);
    d.setHours(t.h, t.m, 0, 0);
    return formatGhlDate(d);
  }

  // slot 0 then slot 1
  const slotIndex = used; // 0 then 1
  slotCounters.set(key, used + 1);

  const t = pickSlotTime(win, slotIndex);
  d.setHours(t.h, t.m, 0, 0);
  return formatGhlDate(d);
}
