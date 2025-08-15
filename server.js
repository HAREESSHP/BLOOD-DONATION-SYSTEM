const express = require('express');
const app = express();
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const webpush = require('web-push');

// Connect to MongoDB
mongoose.connect('mongodb+srv://HARI:9346@cluster0.t1edaad.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0', { useNewUrlParser: true, useUnifiedTopology: true });

// Define middleware
app.use(bodyParser.json());
// Serve static files from the project directory
app.use(express.static(__dirname));

// Define models
const donorSchema = new mongoose.Schema({
  name: String,
  email: { type: String, required: true },
  phone: String,
  bloodGroup: String,
  pushSubscription: Object,
});
const DonorModel = mongoose.model('Donor', donorSchema);

// VAPID keys should be generated once and kept secret
const vapidKeys = {
  publicKey: 'BOqS9zLT-USQBdiBka2zgy--Qi0PKO2xFiGRQdio2NF7-CJdd6WKVgu206ukLXGQPudR7NnF7yvkBteGIJ23Ov8',
  privateKey: 'ZuiRl1C0fm26gQGQSQ5tPcvMuGv09_dUWXaskuLAc4E'
};
webpush.setVapidDetails(
  'mailto:your-email@example.com',
  vapidKeys.publicKey,
  vapidKeys.privateKey
);

const bloodRequestSchema = new mongoose.Schema({
  name: String,
  email: { type: String, required: true },
  phone: String,
  bloodGroup: String,
  hospital: String,
});
const BloodRequestModel = mongoose.model('BloodRequest', bloodRequestSchema);

// Define routes
app.post('/donor', async (req, res) => {
  try {
  const donor = new DonorModel(req.body);
  await donor.save();
  res.send(donor);
  } catch (err) {
    console.error(err);
    res.status(500).send({ message: 'Error creating donor' });
  }
});

app.get('/donor', async (req, res) => {
  try {
    const donors = await DonorModel.find();
    res.send(donors);
  } catch (err) {
    console.error(err);
    res.status(500).send({ message: 'Error getting donors' });
  }
});

app.post('/blood-request', async (req, res) => {
  try {
    const bloodRequest = new BloodRequestModel(req.body);
    await bloodRequest.save();

    // Find matching donors
    const donors = await DonorModel.find({
      bloodGroup: bloodRequest.bloodGroup,
      pushSubscription: { $exists: true }
    });
    // Send push notification to each matching donor (if enabled)
    donors.forEach(donor => {
      if (donor.pushSubscription) {
        webpush.sendNotification(
          donor.pushSubscription,
          JSON.stringify({
            title: 'Blood Donation Request',
            body: `Urgent need for ${bloodRequest.bloodGroup} blood at ${bloodRequest.hospital}.`,
            url: '/'
          })
        ).catch(err => console.error('Push error:', err));
      }
    });
    res.send(bloodRequest);
  } catch (err) {
    console.error(err);
    res.status(500).send({ message: 'Error creating blood request' });
  }
});

app.get('/blood-request', async (req, res) => {
  try {
    const bloodRequests = await BloodRequestModel.find();
    res.send(bloodRequests);
  } catch (err) {
    console.error(err);
    res.status(500).send({ message: 'Error sending notification' });
  }
});

// Start server
const port = 5500;
app.listen(port, () => {
  console.log(`Server started on port ${port}`);
});