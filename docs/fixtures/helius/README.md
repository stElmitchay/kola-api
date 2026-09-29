# Helius webhook fixtures

Live fixture capture was not possible in the sandboxed environment this
work was done in (no live Helius access). This directory is a placeholder
specifying exactly what the founder must capture before the
`// ASSUMPTION(V-D-adjacent)` amount-parse in
`src/routes/webhooks/helius-handler.js` can be treated as verified.

## What to capture

Trigger one real USDC transfer into the treasury wallet (devnet is fine —
`USDC_MINT` + `HELIUS_URL` devnet values) and save the **verbatim** Enhanced
Webhook JSON body Helius POSTs for it to:

```
docs/fixtures/helius/transfer.json
```

Do not redact, reformat, or hand-transcribe it — save the exact bytes
Helius sent, since the whole point is pinning which fields exist.

## What the code currently assumes

`src/routes/webhooks/helius-handler.js`, inside the `tokenTransfers` loop,
marked `// ASSUMPTION(V-D-adjacent): verify against docs/fixtures/helius/ —
fixture wins`:

```js
const amountMinorUnits = t.rawTokenAmount?.tokenAmount != null
  ? Number(t.rawTokenAmount.tokenAmount)   // integer string from Helius — exact
  : new BigNumber(String(t.tokenAmount)).multipliedBy(1_000_000).integerValue(BigNumber.ROUND_HALF_UP).toNumber();
```

The code **prefers `t.rawTokenAmount.tokenAmount`** — expected to be an
integer string already in USDC minor units (e.g. `"5000000"` for 5 USDC,
6 decimals) — because that path is exact: no float ever touches the
amount. If `rawTokenAmount` is absent from a given `tokenTransfers` entry,
it **falls back to exact BigNumber string math on `t.tokenAmount`**
(Helius's human-readable decimal amount, e.g. `5.0`), multiplying by
1,000,000 and rounding half-up — never plain `Number(t.tokenAmount) *
1_000_000` float multiplication, which is the float-precision bug this
task (F18, Helius half) closes.

## Questions to answer

Once `transfer.json` is captured, answer these here (replace this section
with the answers):

1. **Does `rawTokenAmount` exist on the transfer object, and does
   `rawTokenAmount.tokenAmount` hold an integer string in minor units
   (not a decimal)?** Check `tokenTransfers[].rawTokenAmount.tokenAmount`
   and `tokenTransfers[].rawTokenAmount.decimals` in the captured payload.
   If `decimals` is present and not `6`, the `×1_000_000` fallback
   constant is wrong for that mint and must be replaced with
   `10 ** decimals`.

2. **Is `tokenTransfers[].tokenAmount` always present as a fallback**, and
   is it the human-readable decimal amount (i.e. divide-by-10^decimals
   already applied by Helius), matching the BigNumber fallback branch's
   assumption?

3. **Are `fromUserAccount`, `toUserAccount`, and `mint` at the same
   nesting level** (`tokenTransfers[].fromUserAccount` /
   `.toUserAccount` / `.mint`) as currently read in the handler, or
   nested differently in the live payload?

## THE FIXTURE WINS

If the captured fixture contradicts any assumption above, **fix the code
to match the fixture, not the other way around.** Exact location to
correct: `src/routes/webhooks/helius-handler.js`, the
`// ASSUMPTION(V-D-adjacent)` line inside `handleHeliusEvent`'s
`tokenTransfers` loop — grep for `ASSUMPTION(V-D-adjacent)` to find it.
