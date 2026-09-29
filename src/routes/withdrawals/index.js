//@ts-check

import { Hono } from 'hono';
import { apiKeyAuth } from '../../middleware/api-key-auth.js';
import { errorHandler } from '../../middleware/error-handler.js';
import { idempotency } from '../../middleware/idempotency.js';
import {
  createWithdrawalSchema,
  confirmWithdrawalSchema
} from '../../schemas/withdrawal.js';
import {
  initiateWithdrawal,
  confirmWithdrawal,
  getWithdrawalStatus,
  getWithdrawals
} from './withdrawals.js';

const app = new Hono();

app.use('/*', apiKeyAuth);
app.onError(errorHandler);

app.post('/', idempotency('withdrawals'), async (c) => {
  const body = await c.req.json();
  const parsed = createWithdrawalSchema.parse(body);
  const application = c.get('application');

  const withdrawal = await initiateWithdrawal({
    ...parsed,
    application
  });

  return c.json(withdrawal, 201);
});

app.post('/:id/confirm', async (c) => {
  const id = c.req.param('id');
  const application = c.get('application');
  const body = await c.req.json();
  const { solanaTxSignature } = confirmWithdrawalSchema.parse(body);

  const result = await confirmWithdrawal(id, application, solanaTxSignature);
  return c.json(result);
});

app.get('/:id', async (c) => {
  const id = c.req.param('id');
  const application = c.get('application');

  const withdrawal = await getWithdrawalStatus(id, application);
  return c.json(withdrawal);
});

app.get('/', async (c) => {
  const application = c.get('application');
  const filters = {
    phoneNumber: c.req.query('phoneNumber'),
    status: c.req.query('status'),
    limit: c.req.query('limit') ? parseInt(c.req.query('limit')) : undefined,
    offset: c.req.query('offset') ? parseInt(c.req.query('offset')) : undefined
  };

  const withdrawals = await getWithdrawals(application, filters);
  return c.json(withdrawals);
});

export default app;
