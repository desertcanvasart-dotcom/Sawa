// A live (legacy) tour or package is priced in ONE of two ways, and the editor shows
// only the fields of the mode it is in (29 Sep 2026):
//   sliding  a GoAhead price at the minimum group sliding to a break price at the maximum
//   grid     a price for each group size, 4 to the maximum
// In grid mode the GoAhead price and the break price are not entered: they are the
// grid's first and last rows, so every page that still shows "from €X" agrees with it.

// The rows of a price grid that have a price, lowest group size first.
export const gridRows = (rows) => (rows || [])
  .filter((t) => String(t?.price ?? "").trim() !== "" && Number(t.price) > 0)
  .map((t) => ({ seats: Number(t.seats), price: Number(t.price) }))
  .sort((a, b) => a.seats - b.seats);

// The GoAhead price and the break price the listing is saved with.
export function listingPrices({ useTiers, rows, publishedRate, breakPrice }) {
  if (useTiers) {
    const g = gridRows(rows);
    if (!g.length) return { error: "Enter a price for each group size, or use the sliding price." };
    return { publishedRate: g[0].price, breakPrice: Math.min(g[0].price, g[g.length - 1].price) };
  }
  const start = Number(publishedRate);
  if (!(start > 0)) return { error: "GoAhead price must be a positive number." };
  if (breakPrice && Number(breakPrice) > start) return { error: "Break price can't exceed the GoAhead price." };
  return { publishedRate: start, breakPrice: Number(breakPrice || Math.round(start * 0.8)) };
}
