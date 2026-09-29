//@ts-check

import { Hono } from 'hono';
import { apiKeyAuth } from '../../middleware/api-key-auth.js';
import { errorHandler } from '../../middleware/error-handler.js';
import { idempotency } from '../../middleware/idempotency.js';
import { createDepositSchema } from '../../schemas/deposit.js';
import { initiateDeposit, getDepositStatus, getDeposits } from './deposits.js';

const app = new Hono();

app.use('/*', apiKeyAuth);
app.onError(errorHandler);

app.post('/', idempotency('deposits'), async (c) => {
  const body = await c.req.json();
  const parsed = createDepositSchema.parse(body);
  const application = c.get('application');

  const deposit = await initiateDeposit({
    ...parsed,
    application
  });

  return c.json(deposit, 201);
});

app.get('/:id', async (c) => {
  const id = c.req.param('id');
  const application = c.get('application');

  const deposit = await getDepositStatus(id, application);
  return c.json(deposit);
});

app.get('/', async (c) => {
  const application = c.get('application');
  const filters = {
    phoneNumber: c.req.query('phoneNumber'),
    status: c.req.query('status'),
    limit: c.req.query('limit') ? parseInt(c.req.query('limit')) : undefined,
    offset: c.req.query('offset') ? parseInt(c.req.query('offset')) : undefined
  };

  const deposits = await getDeposits(application, filters);
  return c.json(deposits);
});

export default app;
