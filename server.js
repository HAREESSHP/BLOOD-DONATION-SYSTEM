const express = require('express');
const app = express();
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const webpush = require('web-push');
const crypto = require('crypto');

// Load environment variables (you'll need to create a .env file)
require('dotenv').config();

// Connect to MongoDB
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://HARI:9346@cluster0.t1edaad.mongodb.net/bloodconnect?retryWrites=true&w=majority&appName=Cluster0';
mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });

// JWT Secret for Blood Bank authentication
const JWT_SECRET = process.env.JWT_SECRET || 'bloodconnect-secret-key-change-in-production';

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

// Blood Bank User Schema (for authorized personnel)
const bloodBankUserSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true }, // Hashed password
  name: String,
  role: { type: String, enum: ['admin', 'staff'], default: 'staff' },
  bloodBankName: String,
  createdAt: { type: Date, default: Date.now },
  lastLogin: Date,
  isActive: { type: Boolean, default: true }
});
const BloodBankUserModel = mongoose.model('BloodBankUser', bloodBankUserSchema);

// Blood Inventory Schema
const bloodInventorySchema = new mongoose.Schema({
  unitId: { type: String, unique: true },
  bloodGroup: { type: String, required: true },
  quantity: { type: Number, default: 450 }, // in ml
  collectedDate: { type: Date, required: true },
  expiryDate: { type: Date, required: true },
  status: { type: String, enum: ['available', 'reserved', 'used', 'expired'], default: 'available' },
  donorRef: String, // Reference to donor if available
  notes: String,
  addedBy: String, // Username who added
  addedAt: { type: Date, default: Date.now },
  updatedAt: Date
});
bloodInventorySchema.index({ bloodGroup: 1, status: 1 });
bloodInventorySchema.index({ expiryDate: 1 });
const BloodInventoryModel = mongoose.model('BloodInventory', bloodInventorySchema);

// Helper: Generate simple token
function generateToken(user) {
  const payload = {
    id: user._id,
    username: user.username,
    role: user.role,
    exp: Date.now() + (24 * 60 * 60 * 1000) // 24 hours
  };
  const data = JSON.stringify(payload);
  const hash = crypto.createHmac('sha256', JWT_SECRET).update(data).digest('hex');
  return Buffer.from(data).toString('base64') + '.' + hash;
}

// Helper: Verify token
function verifyToken(token) {
  try {
    const [dataB64, hash] = token.split('.');
    const data = Buffer.from(dataB64, 'base64').toString();
    const expectedHash = crypto.createHmac('sha256', JWT_SECRET).update(data).digest('hex');
    if (hash !== expectedHash) return null;
    const payload = JSON.parse(data);
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

// Helper: Hash password
function hashPassword(password) {
  return crypto.createHash('sha256').update(password + JWT_SECRET).digest('hex');
}

// Middleware: Authenticate Blood Bank users
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Unauthorized' });
  }
  const token = authHeader.substring(7);
  const payload = verifyToken(token);
  if (!payload) {
    return res.status(401).json({ message: 'Invalid or expired token' });
  }
  req.user = payload;
  next();
}

// Initialize default admin user if none exists
async function initDefaultAdmin() {
  const adminExists = await BloodBankUserModel.findOne({ role: 'admin' });
  if (!adminExists) {
    await BloodBankUserModel.create({
      username: 'admin',
      password: hashPassword('admin123'),
      name: 'Administrator',
      role: 'admin',
      bloodBankName: 'Central Blood Bank'
    });
    console.log('Default admin created: username=admin, password=admin123');
  }
}
initDefaultAdmin();

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

// ==================== Blood Bank Authentication Routes ====================

// Login
app.post('/api/bloodbank/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ message: 'Username and password required' });
    }
    
    const user = await BloodBankUserModel.findOne({ username, isActive: true });
    if (!user || user.password !== hashPassword(password)) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }
    
    user.lastLogin = new Date();
    await user.save();
    
    const token = generateToken(user);
    res.json({
      token,
      user: {
        id: user._id,
        username: user.username,
        name: user.name,
        role: user.role,
        bloodBankName: user.bloodBankName
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Register new blood bank user (admin only)
app.post('/api/bloodbank/users', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Admin access required' });
    }
    
    const { username, password, name, role, bloodBankName } = req.body;
    const existing = await BloodBankUserModel.findOne({ username });
    if (existing) {
      return res.status(409).json({ message: 'Username already exists' });
    }
    
    const newUser = await BloodBankUserModel.create({
      username,
      password: hashPassword(password),
      name,
      role: role || 'staff',
      bloodBankName
    });
    
    res.json({ message: 'User created', userId: newUser._id });
  } catch (err) {
    console.error('Create user error:', err);
    res.status(500).json({ message: 'Error creating user' });
  }
});

// ==================== Blood Inventory Routes ====================

// Get inventory stats
app.get('/api/bloodbank/inventory/stats', authMiddleware, async (req, res) => {
  try {
    const now = new Date();
    const sevenDaysLater = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    
    // Update expired items
    await BloodInventoryModel.updateMany(
      { expiryDate: { $lt: now }, status: 'available' },
      { status: 'expired', updatedAt: now }
    );
    
    const allInventory = await BloodInventoryModel.find({ status: { $in: ['available', 'reserved'] } });
    
    // Group by blood type
    const byBloodGroup = {};
    ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'].forEach(bg => byBloodGroup[bg] = 0);
    allInventory.forEach(item => {
      if (item.status === 'available') {
        byBloodGroup[item.bloodGroup] = (byBloodGroup[item.bloodGroup] || 0) + 1;
      }
    });
    
    // Low stock (less than 5 units)
    const lowStockGroups = Object.entries(byBloodGroup)
      .filter(([_, count]) => count < 5)
      .map(([bg, _]) => bg);
    
    // Expiring soon
    const expiringSoon = await BloodInventoryModel.countDocuments({
      status: 'available',
      expiryDate: { $gte: now, $lte: sevenDaysLater }
    });
    
    res.json({
      totalUnits: allInventory.length,
      availableUnits: allInventory.filter(i => i.status === 'available').length,
      byBloodGroup,
      lowStockGroups,
      expiringSoon
    });
  } catch (err) {
    console.error('Stats error:', err);
    res.status(500).json({ message: 'Error getting stats' });
  }
});

// Get all inventory
app.get('/api/bloodbank/inventory', authMiddleware, async (req, res) => {
  try {
    const filter = {};
    if (req.query.bloodGroup) filter.bloodGroup = req.query.bloodGroup;
    if (req.query.status) filter.status = req.query.status;
    
    const inventory = await BloodInventoryModel.find(filter).sort({ expiryDate: 1 });
    res.json(inventory);
  } catch (err) {
    console.error('Get inventory error:', err);
    res.status(500).json({ message: 'Error getting inventory' });
  }
});

// Get single inventory item
app.get('/api/bloodbank/inventory/:id', authMiddleware, async (req, res) => {
  try {
    const item = await BloodInventoryModel.findById(req.params.id);
    if (!item) return res.status(404).json({ message: 'Item not found' });
    res.json(item);
  } catch (err) {
    res.status(500).json({ message: 'Error getting item' });
  }
});

// Add new inventory
app.post('/api/bloodbank/inventory', authMiddleware, async (req, res) => {
  try {
    const { bloodGroup, quantity, collectedDate, expiryDate, donorRef, notes } = req.body;
    
    if (!bloodGroup || !collectedDate || !expiryDate) {
      return res.status(400).json({ message: 'Blood group, collected date, and expiry date are required' });
    }
    
    // Generate unique unit ID
    const count = await BloodInventoryModel.countDocuments();
    const unitId = `BU${String(count + 1).padStart(6, '0')}`;
    
    const item = await BloodInventoryModel.create({
      unitId,
      bloodGroup,
      quantity: quantity || 450,
      collectedDate: new Date(collectedDate),
      expiryDate: new Date(expiryDate),
      donorRef,
      notes,
      addedBy: req.user.username,
      status: 'available'
    });
    
    res.json(item);
  } catch (err) {
    console.error('Add inventory error:', err);
    res.status(500).json({ message: 'Error adding inventory' });
  }
});

// Update inventory item
app.patch('/api/bloodbank/inventory/:id', authMiddleware, async (req, res) => {
  try {
    const { quantity, status, notes } = req.body;
    const update = { updatedAt: new Date() };
    if (quantity !== undefined) update.quantity = quantity;
    if (status) update.status = status;
    if (notes !== undefined) update.notes = notes;
    
    const item = await BloodInventoryModel.findByIdAndUpdate(
      req.params.id,
      update,
      { new: true }
    );
    
    if (!item) return res.status(404).json({ message: 'Item not found' });
    res.json(item);
  } catch (err) {
    console.error('Update inventory error:', err);
    res.status(500).json({ message: 'Error updating inventory' });
  }
});

// Delete inventory item
app.delete('/api/bloodbank/inventory/:id', authMiddleware, async (req, res) => {
  try {
    const item = await BloodInventoryModel.findByIdAndDelete(req.params.id);
    if (!item) return res.status(404).json({ message: 'Item not found' });
    res.json({ message: 'Item deleted' });
  } catch (err) {
    res.status(500).json({ message: 'Error deleting item' });
  }
});

// Admin: Update blood request status (Blood Bank authorized)
app.patch('/api/requests/:id', authMiddleware, async (req, res) => {
  try {
    const { status } = req.body;
    if (!status) {
      return res.status(400).json({ message: 'Status is required' });
    }
    
    const reqDoc = await BloodRequestModel.findByIdAndUpdate(
      req.params.id,
      { 
        status, 
        resolvedAt: status === 'accepted' ? new Date() : undefined 
      },
      { new: true }
    );
    
    if (!reqDoc) return res.status(404).json({ message: 'Request not found' });
    res.json(reqDoc);
  } catch (err) {
    console.error('Update request error:', err);
    res.status(500).json({ message: 'Error updating request' });
  }
});

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

// Blood Compatibility Chart - Which donors can donate to which recipients
// Key = Recipient blood type, Value = Array of compatible donor blood types
const bloodCompatibility = {
  'O-':  ['O-'],
  'O+':  ['O-', 'O+'],
  'A-':  ['O-', 'A-'],
  'A+':  ['O-', 'O+', 'A-', 'A+'],
  'B-':  ['O-', 'B-'],
  'B+':  ['O-', 'O+', 'B-', 'B+'],
  'AB-': ['O-', 'A-', 'B-', 'AB-'],
  'AB+': ['O-', 'O+', 'A-', 'A+', 'B-', 'B+', 'AB-', 'AB+'] // Universal recipient
};

// Get compatible donor blood types for a recipient
function getCompatibleDonorTypes(recipientBloodGroup) {
  return bloodCompatibility[recipientBloodGroup] || [recipientBloodGroup];
}

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

    // Find compatible donors based on blood compatibility rules
    const compatibleDonorTypes = getCompatibleDonorTypes(bloodRequest.bloodGroup);
    const donors = await DonorModel.find({
      bloodGroup: { $in: compatibleDonorTypes },
      isAvailable: true,
      pushSubscription: { $exists: true }
    });

    // Send push notification to each compatible donor
    const notifications = donors.map(donor => {
      if (donor.pushSubscription && donor.notificationsEnabled) {
        return webpush.sendNotification(
          donor.pushSubscription,
          JSON.stringify({
            title: '🩸 Blood Donation Request',
            body: `Urgent: ${bloodRequest.bloodGroup} blood needed at ${bloodRequest.hospitalName}, ${bloodRequest.hospitalLocation}. Your ${donor.bloodGroup} blood can help!`,
            url: '/',
            requestId: bloodRequest._id
          })
        ).catch(err => console.error('Push error:', err));
      }
      return Promise.resolve();
    });
    await Promise.allSettled(notifications);

    res.send({ ...bloodRequest.toObject(), notifiedDonors: donors.length });
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

    // Find compatible donors based on blood compatibility rules
    const compatibleDonorTypes = getCompatibleDonorTypes(bloodRequest.bloodGroup);
    const donors = await DonorModel.find({
      bloodGroup: { $in: compatibleDonorTypes },
      pushSubscription: { $exists: true }
    });
    // Send push notification to each compatible donor
    donors.forEach(donor => {
      if (donor.pushSubscription) {
        webpush.sendNotification(
          donor.pushSubscription,
          JSON.stringify({
            title: '🩸 Blood Donation Request',
            body: `Urgent: ${bloodRequest.bloodGroup} blood needed at ${bloodRequest.hospitalName || bloodRequest.hospital}. Your ${donor.bloodGroup} blood can help!`,
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

// For local development
if (process.env.NODE_ENV !== 'production') {
  app.listen(port, () => {
    console.log(`Server started on port ${port}`);
  });
}

// Export for Vercel
module.exports = app;