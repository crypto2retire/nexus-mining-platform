require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const apiRouter = require('./routes/api');
const { startDepositListener } = require('./services/depositListener');
const { startPayoutTrigger } = require('./services/payoutTrigger');
const { startRentalScheduler } = require('./services/rentalScheduler');
const { startAccrualDistributor } = require('./services/accrualDistributor');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.use('/api', apiRouter);

if (process.env.NODE_ENV === 'production') {
  // index.html must always revalidate so new builds reach users;
  // hashed assets are immutable by filename so cache them hard.
  app.use(
    express.static(path.join(__dirname, '../frontend/dist'), {
      setHeaders(res, filePath) {
        if (filePath.endsWith('index.html')) {
          res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        } else {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    })
  );
  app.get('*', (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(path.join(__dirname, '../frontend/dist/index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`Nexus backend running on port ${PORT}`);
  startDepositListener();
  startPayoutTrigger();
  startRentalScheduler();
  startAccrualDistributor();
});
