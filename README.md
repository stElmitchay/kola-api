# Kola API

Mobile Money to USDC on-ramp for Sierra Leone. Convert SLE (Leones) to USDC on Solana via Orange Money and Africell Money.

## Documentation

**[https://kola.mintlify.app](https://kola.mintlify.app/introduction)**

## Quick Start

```bash
# Create an API key
curl -X POST https://kola-api-beta.vercel.app/api/v1/admin/api-keys \
  -H "Content-Type: application/json" \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" \
  -d '{"name": "My App", "businessName": "My Business", "appName": "My App"}'

# Set an exchange rate
curl -X PUT https://kola-api-beta.vercel.app/api/v1/admin/exchange-rates \
  -H "Content-Type: application/json" \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" \
  -H "X-Application-Id: YOUR_APP_ID" \
  -d '{"rate": 25, "setBy": "admin"}'

# Create a deposit
curl -X POST https://kola-api-beta.vercel.app/api/v1/deposits \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_API_KEY" \
  -d '{"amount": 50000, "currency": "SLE", "paymentMethod": "ussd", "phoneNumber": "+23276123456"}'
```

## Stack

- **Runtime:** Hono JS on Vercel
- **Database:** Supabase (PostgreSQL)
- **Blockchain:** Solana (USDC SPL token)
- **Payments:** Monime (mobile money gateway)

## API Base URL

```
https://kola-api-beta.vercel.app/api/v1
```

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/public/health` | None | Health check |
| GET | `/public/providers` | None | List mobile money providers |
| GET | `/public/rate` | None | Get exchange rate |
| POST | `/deposits` | API Key | Create deposit |
| GET | `/deposits/:id` | API Key | Get deposit status |
| GET | `/deposits` | API Key | List deposits |
| POST | `/wallets/derive` | API Key | Derive wallet from phone |
| GET | `/wallets/:address/balance` | API Key | Get USDC balance |
| POST | `/admin/api-keys` | Admin | Create API key |
| GET | `/admin/api-keys` | Admin | List API keys |
| DELETE | `/admin/api-keys/:id` | Admin | Revoke API key |
| PUT | `/admin/exchange-rates` | Admin | Set exchange rate |
| GET | `/admin/exchange-rates` | Admin | Get rate history |

## License

Private
