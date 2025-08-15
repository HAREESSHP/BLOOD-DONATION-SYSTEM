const express = require('express');
const app = express();
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const webpush = require('web-push');

// Load environment variables (you'll need to create a .env file)
require('dotenv').config();

// Connect to MongoDB
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://HARI:9346@cluster0.t1edaad.mongodb.net/bloodconnect?retryWrites=true&w=majority&appName=Cluster0';
mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });

// Define middleware
app.use(bodyParser.json());
// Serve static files from the project directory
app.use(express.static(__dirname));

// Define models with extended schemas to match client data
const donorSchema = new mongoose.Schema({
  name: String,
  email: { type: String },
  phone: String,
  bloodGroup: String,
  location: String,
  notificationsEnabled: Boolean,
  registeredAt: Date,
  isAvailable: { type: Boolean, default: true },
  pushSubscription: Object,
});
donorSchema.index({ phone: 1 }, { unique: true, sparse: true });
donorSchema.index({ email: 1 }, { unique: true, sparse: true });
const DonorModel = mongoose.model('Donor', donorSchema);

// VAPID keys should be generated once and kept secret
const vapidKeys = {
  publicKey: process.env.VAPID_PUBLIC_KEY || 'BOqS9zLT-USQBdiBka2zgy--Qi0PKO2xFiGRQdio2NF7-CJdd6WKVgu206ukLXGQPudR7NnF7yvkBteGIJ23Ov8',
  privateKey: process.env.VAPID_PRIVATE_KEY || 'ZuiRl1C0fm26gQGQSQ5tPcvMuGv09_dUWXaskuLAc4E'
};
webpush.setVapidDetails(
  process.env.VAPID_CONTACT_EMAIL || 'mailto:admin@bloodconnect.com',
  vapidKeys.publicKey,
  vapidKeys.privateKey
);

const bloodRequestSchema = new mongoose.Schema({
  requesterName: String,
  email: { type: String },
  phone: String,
  bloodGroup: String,
  hospitalName: String,
  hospitalLocation: String,
  urgency: String,
  notes: String,
  requestedAt: Date,
  status: { type: String, default: 'pending' },
  donorDetails: Object, // Will store matched donor info
  manageCode: String,
  resolvedAt: Date,
});
// Prevent duplicates of pending requests for same phone+bloodGroup within 1 hour
bloodRequestSchema.index(
  { phone: 1, bloodGroup: 1, status: 1 },
  { partialFilterExpression: { status: 'pending' } }
);
const BloodRequestModel = mongoose.model('BloodRequest', bloodRequestSchema);

// Message schema for in-app communication
const messageSchema = new mongoose.Schema({
  sender: String,
  receiverId: String,
  content: String,
  sentAt: { type: Date, default: Date.now },
});
const MessageModel = mongoose.model('Message', messageSchema);

// Define routes - Updated to match client expectations
app.post('/api/donors', async (req, res) => {
  try {
    // Normalize payload from new HTML
    const payload = { ...req.body };
    if (typeof payload.enableNotifications === 'boolean' && payload.notificationsEnabled === undefined) {
      payload.notificationsEnabled = payload.enableNotifications;
    }
    // Upsert donor by phone or email
    const query = payload.phone ? { phone: payload.phone } : (payload.email ? { email: payload.email } : null);
    if (!query) {
      return res.status(400).send({ message: 'Phone or email is required' });
    }
    const donor = await DonorModel.findOneAndUpdate(query, payload, { new: true, upsert: true, setDefaultsOnInsert: true });
    res.send(donor);
  } catch (err) {
    console.error(err);
    if (err.code === 11000) {
      return res.status(409).send({ message: 'Donor already exists' });
    }
    res.status(500).send({ message: 'Error creating donor' });
  }
});

app.get('/api/donors', async (req, res) => {
  try {
    const donors = await DonorModel.find();
    res.send(donors);
  } catch (err) {
    console.error(err);
    res.status(500).send({ message: 'Error getting donors' });
  }
});

app.post('/api/requests', async (req, res) => {
  try {
    // Normalize payload from new HTML
    const payload = { ...req.body };
    if (payload.requiredBloodGroup && !payload.bloodGroup) {
      payload.bloodGroup = payload.requiredBloodGroup;
    }
    if (payload.receiverName && !payload.requesterName) {
      payload.requesterName = payload.receiverName;
    }
    if (!payload.requestedAt) {
      payload.requestedAt = new Date();
    }
    // Avoid duplicate pending requests for same phone+bloodGroup
    const exists = await BloodRequestModel.findOne({
      phone: payload.phone,
      bloodGroup: payload.bloodGroup,
      status: 'pending'
    });
    if (exists) {
      return res.status(409).send({ message: 'A pending request already exists for this phone and blood group' });
    }
    // generate a simple management code for resolving/removing later
    payload.manageCode = (Math.floor(100000 + Math.random()*900000)).toString();
    const bloodRequest = new BloodRequestModel(payload);
    await bloodRequest.save();

    // Find matching donors
    const donors = await DonorModel.find({
      bloodGroup: bloodRequest.bloodGroup,
      isAvailable: true,
      pushSubscription: { $exists: true }
    });

    // Send push notification to each matching donor
    const notifications = donors.map(donor => {
      if (donor.pushSubscription && donor.notificationsEnabled) {
        return webpush.sendNotification(
          donor.pushSubscription,
          JSON.stringify({
            title: 'Blood Donation Request',
            body: `Urgent need for ${bloodRequest.bloodGroup} blood at ${bloodRequest.hospitalName} in ${bloodRequest.hospitalLocation}.`,
            url: '/',
            requestId: bloodRequest._id
          })
        ).catch(err => console.error('Push error:', err));
      }
      return Promise.resolve();
    });
    await Promise.allSettled(notifications);

    res.send(bloodRequest);
  } catch (err) {
    console.error(err);
    res.status(500).send({ message: 'Error creating blood request' });
  }
});

app.get('/api/requests', async (req, res) => {
  try {
    const bloodRequests = await BloodRequestModel.find();
    res.send(bloodRequests);
  } catch (err) {
    console.error(err);
    res.status(500).send({ message: 'Error getting blood requests' });
  }
});

// New endpoint for getting specific request by ID
app.get('/api/requests/:id', async (req, res) => {
  try {
    const request = await BloodRequestModel.findById(req.params.id);
    if (!request) {
      return res.status(404).send({ message: 'Request not found' });
    }
    res.send(request);
  } catch (err) {
    console.error(err);
    res.status(500).send({ message: 'Error getting request' });
  }
});

// Resolve (mark as received) a request; requires manageCode or matching email+phone
app.patch('/api/requests/:id/resolve', async (req, res) => {
  try {
    const { manageCode, email, phone } = req.body || {};
    const reqDoc = await BloodRequestModel.findById(req.params.id);
    if (!reqDoc) return res.status(404).send({ message: 'Request not found' });

    const codeOk = manageCode && reqDoc.manageCode && manageCode === reqDoc.manageCode;
    const contactOk = email && phone && reqDoc.email === email && reqDoc.phone === phone;
    if (!codeOk && !contactOk) {
      return res.status(403).send({ message: 'Verification failed. Provide correct code or matching email and phone.' });
    }

    reqDoc.status = 'accepted';
    reqDoc.resolvedAt = new Date();
    await reqDoc.save();
    res.send({ ok: true, request: reqDoc });
  } catch (err) {
    console.error(err);
    res.status(500).send({ message: 'Error resolving request' });
  }
});

// Reveal management code (requires matching email+phone)
app.post('/api/requests/:id/reveal-code', async (req, res) => {
  try {
    const { email, phone } = req.body || {};
    if (!email || !phone) return res.status(400).send({ message: 'Email and phone are required' });
    const reqDoc = await BloodRequestModel.findById(req.params.id);
    if (!reqDoc) return res.status(404).send({ message: 'Request not found' });
    if (reqDoc.email !== email || reqDoc.phone !== phone) {
      return res.status(403).send({ message: 'Verification failed' });
    }
    res.send({ manageCode: reqDoc.manageCode || null });
  } catch (err) {
    console.error(err);
    res.status(500).send({ message: 'Error revealing code' });
  }
});

// New endpoint for messages
app.get('/api/messages/:receiverId', async (req, res) => {
  try {
    const messages = await MessageModel.find({ receiverId: req.params.receiverId });
    res.send(messages);
  } catch (err) {
    console.error(err);
    res.status(500).send({ message: 'Error getting messages' });
  }
});

// Optional: stats endpoint to power hero counters if needed later
app.get('/api/stats', async (_req, res) => {
  try {
    const [donorsCount, openRequestsCount] = await Promise.all([
      DonorModel.countDocuments(),
      BloodRequestModel.countDocuments({ status: { $ne: 'accepted' } })
    ]);
    res.send({ donorsCount, openRequestsCount });
  } catch (err) {
    console.error(err);
    res.status(500).send({ message: 'Error getting stats' });
  }
});

// Serve firebase-config.js if referenced by HTML
app.get('/firebase-config.js', (_req, res) => {
  const cfg = {
    apiKey: process.env.FIREBASE_API_KEY || '',
    authDomain: process.env.FIREBASE_AUTH_DOMAIN || '',
    projectId: process.env.FIREBASE_PROJECT_ID || '',
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET || '',
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || '',
    appId: process.env.FIREBASE_APP_ID || '',
    measurementId: process.env.FIREBASE_MEASUREMENT_ID || ''
  };
  res.setHeader('Content-Type', 'application/javascript');
  res.send(`window.firebaseConfig = ${JSON.stringify(cfg)};`);
});

// Keep legacy routes for backward compatibility
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
            body: `Urgent need for ${bloodRequest.bloodGroup} blood at ${bloodRequest.hospitalName || bloodRequest.hospital}.`,
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
const port = process.env.PORT || 5500;
app.listen(port, () => {
  console.log(`Server started on port ${port}`);
});