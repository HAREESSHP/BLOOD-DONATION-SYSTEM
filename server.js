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
let dbConnected = false;
mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => {
    console.log('MongoDB connected');
    dbConnected = true;
    initDefaultAdmin();
  })
  .catch(err => console.error('MongoDB connection error:', err));

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
  bloodBankId: { type: mongoose.Schema.Types.ObjectId, ref: 'BloodBank' }, // Link to specific blood bank
  createdAt: { type: Date, default: Date.now },
  lastLogin: Date,
  isActive: { type: Boolean, default: true }
});
bloodBankUserSchema.index({ bloodBankId: 1 });
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
  bloodBankId: { type: mongoose.Schema.Types.ObjectId, ref: 'BloodBank' }, // Link to specific blood bank
  addedAt: { type: Date, default: Date.now },
  updatedAt: Date
});
bloodInventorySchema.index({ bloodGroup: 1, status: 1 });
bloodInventorySchema.index({ expiryDate: 1 });
bloodInventorySchema.index({ bloodBankId: 1 });
const BloodInventoryModel = mongoose.model('BloodInventory', bloodInventorySchema);

// Helper: Generate simple token
function generateToken(user) {
  const payload = {
    id: user._id,
    username: user.username,
    role: user.role,
    bloodBankId: user.bloodBankId,
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
  try {
    // Force update or create admin user with correct credentials
    const hashedPwd = hashPassword('Pavan123');
    console.log('Admin password hash:', hashedPwd.substring(0, 20) + '...');
    
    const result = await BloodBankUserModel.findOneAndUpdate(
      { username: 'Pavan' },
      {
        username: 'Pavan',
        password: hashedPwd,
        name: 'Administrator',
        role: 'admin',
        bloodBankName: 'Central Blood Bank',
        isActive: true
      },
      { upsert: true, new: true }
    );
    console.log('Admin user ready: username=Pavan, password=Pavan123');
  } catch (err) {
    console.error('Error initializing admin:', err.message);
  }
}
// initDefaultAdmin is called after MongoDB connects

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
  patientLatitude: Number,
  patientLongitude: Number,
  urgency: String,
  notes: String,
  requestedAt: Date,
  status: { type: String, default: 'pending' },
  donorDetails: Object, // Will store matched donor info
  manageCode: String,
  resolvedAt: Date,
  nearestBloodBanks: [{ // Store nearest blood banks for the request
    bankId: mongoose.Schema.Types.ObjectId,
    name: String,
    address: String,
    distance: Number,
    availableUnits: Number
  }]
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

// Blood Bank Schema - Multi Blood Bank Support
const bloodBankSchema = new mongoose.Schema({
  name: { type: String, required: true },
  address: { type: String, required: true },
  latitude: { type: Number, required: true },
  longitude: { type: Number, required: true },
  contactNumber: { type: String, required: true },
  email: String,
  operatingHours: {
    open: { type: String, default: '08:00' },
    close: { type: String, default: '20:00' }
  },
  bloodInventory: {
    'A+': { type: Number, default: 0 },
    'A-': { type: Number, default: 0 },
    'B+': { type: Number, default: 0 },
    'B-': { type: Number, default: 0 },
    'O+': { type: Number, default: 0 },
    'O-': { type: Number, default: 0 },
    'AB+': { type: Number, default: 0 },
    'AB-': { type: Number, default: 0 }
  },
  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: Date
});
bloodBankSchema.index({ latitude: 1, longitude: 1 });
bloodBankSchema.index({ isActive: 1 });
const BloodBankModel = mongoose.model('BloodBank', bloodBankSchema);

// Haversine formula to calculate distance between two coordinates (in kilometers)
function calculateHaversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth's radius in kilometers
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c; // Distance in km
}

// Estimate travel time based on distance (assuming average speed of 30 km/h in city)
function estimateTravelTime(distanceKm) {
  const avgSpeedKmH = 30;
  const timeHours = distanceKm / avgSpeedKmH;
  const timeMinutes = Math.round(timeHours * 60);
  if (timeMinutes < 60) {
    return `${timeMinutes} min`;
  }
  const hours = Math.floor(timeMinutes / 60);
  const mins = timeMinutes % 60;
  return `${hours}h ${mins}min`;
}

// ==================== Blood Bank Authentication Routes ====================

// Initialize/reset admin endpoint (call this once on Vercel to set up admin)
app.get('/api/bloodbank/init-admin', async (req, res) => {
  try {
    const existingAdmin = await BloodBankUserModel.findOne({ username: 'Pavan' });
    if (existingAdmin) {
      existingAdmin.password = hashPassword('Pavan123');
      existingAdmin.isActive = true;
      existingAdmin.role = 'admin';
      await existingAdmin.save();
      return res.json({ message: 'Admin password updated successfully' });
    }
    
    await BloodBankUserModel.create({
      username: 'Pavan',
      password: hashPassword('Pavan123'),
      name: 'Administrator',
      role: 'admin',
      bloodBankName: 'Central Blood Bank',
      isActive: true
    });
    res.json({ message: 'Admin created successfully' });
  } catch (err) {
    res.status(500).json({ message: 'Error: ' + err.message });
  }
});

// Login
app.post('/api/bloodbank/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    console.log('Login attempt:', { username, passwordLength: password?.length });
    
    if (!username || !password) {
      return res.status(400).json({ message: 'Username and password required' });
    }
    
    // Ensure admin exists before checking credentials
    if (username === 'Pavan') {
      await initDefaultAdmin();
    }
    
    const user = await BloodBankUserModel.findOne({ username, isActive: true });
    console.log('User found:', user ? { id: user._id, username: user.username, isActive: user.isActive } : 'null');
    
    if (!user) {
      console.log('User not found for username:', username);
      return res.status(401).json({ message: 'Invalid credentials' });
    }
    
    const inputHash = hashPassword(password);
    const match = user.password === inputHash;
    console.log('Password match:', match);
    
    if (!match) {
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
        bloodBankName: user.bloodBankName,
        bloodBankId: user.bloodBankId
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Register new blood bank with user account (public registration)
app.post('/api/bloodbank/register', async (req, res) => {
  try {
    const { 
      // Blood bank details
      bankName, 
      address, 
      latitude, 
      longitude, 
      contactNumber, 
      email,
      // User credentials
      username, 
      password, 
      adminName 
    } = req.body;
    
    // Validate required fields
    if (!bankName || !address || latitude === undefined || longitude === undefined || !contactNumber) {
      return res.status(400).json({ message: 'Blood bank name, address, coordinates, and contact number are required' });
    }
    
    if (!username || !password) {
      return res.status(400).json({ message: 'Username and password are required' });
    }
    
    if (password.length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 characters' });
    }
    
    // Check if username already exists
    const existingUser = await BloodBankUserModel.findOne({ username });
    if (existingUser) {
      return res.status(409).json({ message: 'Username already exists. Please choose a different username.' });
    }
    
    // Check if blood bank with same name already exists
    const existingBank = await BloodBankModel.findOne({ name: bankName });
    if (existingBank) {
      return res.status(409).json({ message: 'A blood bank with this name already exists.' });
    }
    
    // Create the blood bank
    const bloodBank = await BloodBankModel.create({
      name: bankName,
      address,
      latitude: parseFloat(latitude),
      longitude: parseFloat(longitude),
      contactNumber,
      email: email || '',
      bloodInventory: {
        'A+': 0, 'A-': 0, 'B+': 0, 'B-': 0,
        'O+': 0, 'O-': 0, 'AB+': 0, 'AB-': 0
      },
      isActive: true
    });
    
    // Create the admin user for this blood bank
    const newUser = await BloodBankUserModel.create({
      username,
      password: hashPassword(password),
      name: adminName || username,
      role: 'admin',
      bloodBankName: bankName,
      bloodBankId: bloodBank._id,
      isActive: true
    });
    
    console.log('New blood bank registered:', bankName, 'by user:', username);
    
    // Auto-login after registration
    const token = generateToken(newUser);
    
    res.json({
      message: 'Blood bank registered successfully',
      token,
      user: {
        id: newUser._id,
        username: newUser.username,
        name: newUser.name,
        role: newUser.role,
        bloodBankName: newUser.bloodBankName,
        bloodBankId: bloodBank._id
      },
      bloodBank: {
        id: bloodBank._id,
        name: bloodBank.name,
        address: bloodBank.address,
        latitude: bloodBank.latitude,
        longitude: bloodBank.longitude
      }
    });
  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).json({ message: 'Error registering blood bank: ' + err.message });
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
    
    // Build filter based on user's blood bank (admin sees all, staff sees their bank only)
    const bankFilter = req.user.bloodBankId ? { bloodBankId: req.user.bloodBankId } : {};
    
    // Update expired items
    await BloodInventoryModel.updateMany(
      { ...bankFilter, expiryDate: { $lt: now }, status: 'available' },
      { status: 'expired', updatedAt: now }
    );
    
    const allInventory = await BloodInventoryModel.find({ ...bankFilter, status: { $in: ['available', 'reserved'] } });
    
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
      ...bankFilter,
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
    // Filter by blood bank for non-admin users
    if (req.user.bloodBankId) {
      filter.bloodBankId = req.user.bloodBankId;
    }
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
      bloodBankId: req.user.bloodBankId, // Link to user's blood bank
      status: 'available'
    });
    
    // Also update the blood bank's inventory count
    if (req.user.bloodBankId) {
      const bloodBank = await BloodBankModel.findById(req.user.bloodBankId);
      if (bloodBank) {
        bloodBank.bloodInventory[bloodGroup] = (bloodBank.bloodInventory[bloodGroup] || 0) + 1;
        await bloodBank.save();
      }
    }
    
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
    
    // Handle patient location
    if (payload.patientLatitude !== undefined) {
      payload.patientLatitude = parseFloat(payload.patientLatitude);
    }
    if (payload.patientLongitude !== undefined) {
      payload.patientLongitude = parseFloat(payload.patientLongitude);
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
    
    // If patient location is provided, find nearest blood banks with available blood
    let nearestBanks = [];
    if (payload.patientLatitude && payload.patientLongitude && payload.bloodGroup) {
      const allBloodBanks = await BloodBankModel.find({ isActive: true });
      const availableBanks = allBloodBanks.filter(bank => {
        const inventory = bank.bloodInventory[payload.bloodGroup] || 0;
        return inventory > 0;
      });
      
      const banksWithDistance = availableBanks.map(bank => {
        const distance = calculateHaversineDistance(
          payload.patientLatitude,
          payload.patientLongitude,
          bank.latitude,
          bank.longitude
        );
        return {
          bankId: bank._id,
          name: bank.name,
          address: bank.address,
          distance: Math.round(distance * 100) / 100,
          availableUnits: bank.bloodInventory[payload.bloodGroup]
        };
      });
      
      banksWithDistance.sort((a, b) => a.distance - b.distance);
      nearestBanks = banksWithDistance.slice(0, 3);
      payload.nearestBloodBanks = nearestBanks;
    }
    
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

    res.send({ 
      ...bloodRequest.toObject(), 
      notifiedDonors: donors.length,
      nearestBloodBanks: nearestBanks
    });
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

// ==================== Blood Bank Management Routes ====================

// Get all blood banks
app.get('/api/bloodbanks', async (req, res) => {
  try {
    const bloodBanks = await BloodBankModel.find({ isActive: true });
    res.json(bloodBanks);
  } catch (err) {
    console.error('Get blood banks error:', err);
    res.status(500).json({ message: 'Error getting blood banks' });
  }
});

// Get single blood bank
app.get('/api/bloodbanks/:id', async (req, res) => {
  try {
    const bloodBank = await BloodBankModel.findById(req.params.id);
    if (!bloodBank) return res.status(404).json({ message: 'Blood bank not found' });
    res.json(bloodBank);
  } catch (err) {
    res.status(500).json({ message: 'Error getting blood bank' });
  }
});

// Create new blood bank (admin only)
app.post('/api/bloodbanks', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Admin access required' });
    }
    
    const { name, address, latitude, longitude, contactNumber, email, operatingHours, bloodInventory } = req.body;
    
    if (!name || !address || latitude === undefined || longitude === undefined || !contactNumber) {
      return res.status(400).json({ message: 'Name, address, coordinates, and contact number are required' });
    }
    
    const bloodBank = await BloodBankModel.create({
      name,
      address,
      latitude: parseFloat(latitude),
      longitude: parseFloat(longitude),
      contactNumber,
      email,
      operatingHours,
      bloodInventory: bloodInventory || {}
    });
    
    res.json(bloodBank);
  } catch (err) {
    console.error('Create blood bank error:', err);
    res.status(500).json({ message: 'Error creating blood bank' });
  }
});

// Update blood bank
app.patch('/api/bloodbanks/:id', authMiddleware, async (req, res) => {
  try {
    const { name, address, latitude, longitude, contactNumber, email, operatingHours, bloodInventory, isActive } = req.body;
    const update = { updatedAt: new Date() };
    
    if (name) update.name = name;
    if (address) update.address = address;
    if (latitude !== undefined) update.latitude = parseFloat(latitude);
    if (longitude !== undefined) update.longitude = parseFloat(longitude);
    if (contactNumber) update.contactNumber = contactNumber;
    if (email !== undefined) update.email = email;
    if (operatingHours) update.operatingHours = operatingHours;
    if (bloodInventory) update.bloodInventory = bloodInventory;
    if (isActive !== undefined) update.isActive = isActive;
    
    const bloodBank = await BloodBankModel.findByIdAndUpdate(
      req.params.id,
      update,
      { new: true }
    );
    
    if (!bloodBank) return res.status(404).json({ message: 'Blood bank not found' });
    res.json(bloodBank);
  } catch (err) {
    console.error('Update blood bank error:', err);
    res.status(500).json({ message: 'Error updating blood bank' });
  }
});

// Update blood inventory for a specific blood bank
app.patch('/api/bloodbanks/:id/inventory', authMiddleware, async (req, res) => {
  try {
    const { bloodGroup, quantity, operation } = req.body;
    
    if (!bloodGroup || !['A+', 'A-', 'B+', 'B-', 'O+', 'O-', 'AB+', 'AB-'].includes(bloodGroup)) {
      return res.status(400).json({ message: 'Valid blood group is required' });
    }
    
    const bloodBank = await BloodBankModel.findById(req.params.id);
    if (!bloodBank) return res.status(404).json({ message: 'Blood bank not found' });
    
    const currentQty = bloodBank.bloodInventory[bloodGroup] || 0;
    let newQty;
    
    if (operation === 'set') {
      newQty = parseInt(quantity) || 0;
    } else if (operation === 'add') {
      newQty = currentQty + (parseInt(quantity) || 0);
    } else if (operation === 'subtract') {
      newQty = Math.max(0, currentQty - (parseInt(quantity) || 0));
    } else {
      newQty = parseInt(quantity) || 0;
    }
    
    bloodBank.bloodInventory[bloodGroup] = newQty;
    bloodBank.updatedAt = new Date();
    await bloodBank.save();
    
    res.json(bloodBank);
  } catch (err) {
    console.error('Update inventory error:', err);
    res.status(500).json({ message: 'Error updating inventory' });
  }
});

// Delete blood bank
app.delete('/api/bloodbanks/:id', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Admin access required' });
    }
    
    const bloodBank = await BloodBankModel.findByIdAndDelete(req.params.id);
    if (!bloodBank) return res.status(404).json({ message: 'Blood bank not found' });
    res.json({ message: 'Blood bank deleted' });
  } catch (err) {
    res.status(500).json({ message: 'Error deleting blood bank' });
  }
});

// ==================== Blood Availability Search API ====================

// Search for blood availability at nearby blood banks
app.post('/api/search-blood', async (req, res) => {
  try {
    const { bloodGroup, latitude, longitude, maxDistance } = req.body;
    
    if (!bloodGroup) {
      return res.status(400).json({ message: 'Blood group is required' });
    }
    
    if (latitude === undefined || longitude === undefined) {
      return res.status(400).json({ message: 'Patient location (latitude, longitude) is required' });
    }
    
    const patientLat = parseFloat(latitude);
    const patientLng = parseFloat(longitude);
    const maxDistanceKm = parseFloat(maxDistance) || 50; // Default 50km radius
    
    // Get all active blood banks
    const allBloodBanks = await BloodBankModel.find({ isActive: true });
    
    // Filter blood banks that have the required blood group available (inventory > 0)
    const availableBanks = allBloodBanks.filter(bank => {
      const inventory = bank.bloodInventory[bloodGroup] || 0;
      return inventory > 0;
    });
    
    // Calculate distance for each available blood bank
    const banksWithDistance = availableBanks.map(bank => {
      const distance = calculateHaversineDistance(
        patientLat,
        patientLng,
        bank.latitude,
        bank.longitude
      );
      return {
        _id: bank._id,
        name: bank.name,
        address: bank.address,
        latitude: bank.latitude,
        longitude: bank.longitude,
        contactNumber: bank.contactNumber,
        email: bank.email,
        operatingHours: bank.operatingHours,
        bloodInventory: bank.bloodInventory,
        availableUnits: bank.bloodInventory[bloodGroup],
        distance: Math.round(distance * 100) / 100, // Round to 2 decimal places
        estimatedTime: estimateTravelTime(distance)
      };
    });
    
    // Filter by max distance
    const nearbyBanks = banksWithDistance.filter(bank => bank.distance <= maxDistanceKm);
    
    // Sort by distance (nearest first)
    nearbyBanks.sort((a, b) => a.distance - b.distance);
    
    // Return top 3 nearest blood banks
    const top3Banks = nearbyBanks.slice(0, 3);
    
    res.json({
      bloodGroup,
      patientLocation: { latitude: patientLat, longitude: patientLng },
      totalFound: nearbyBanks.length,
      nearestBanks: top3Banks,
      allNearbyBanks: nearbyBanks // Include all for map display
    });
  } catch (err) {
    console.error('Search blood error:', err);
    res.status(500).json({ message: 'Error searching for blood' });
  }
});

// Get blood availability summary across all banks
app.get('/api/blood-availability', async (req, res) => {
  try {
    const bloodBanks = await BloodBankModel.find({ isActive: true });
    
    // Aggregate inventory across all banks
    const totalInventory = {
      'A+': 0, 'A-': 0, 'B+': 0, 'B-': 0,
      'O+': 0, 'O-': 0, 'AB+': 0, 'AB-': 0
    };
    
    bloodBanks.forEach(bank => {
      Object.keys(totalInventory).forEach(bg => {
        totalInventory[bg] += (bank.bloodInventory[bg] || 0);
      });
    });
    
    res.json({
      totalBanks: bloodBanks.length,
      inventory: totalInventory
    });
  } catch (err) {
    console.error('Get blood availability error:', err);
    res.status(500).json({ message: 'Error getting blood availability' });
  }
});

// Seed sample blood banks (for development)
app.post('/api/bloodbanks/seed', async (req, res) => {
  try {
    const { force } = req.body || {};
    
    // If force=true, delete all existing and reseed
    if (force) {
      await BloodBankModel.collection.drop().catch(() => {}); // Drop collection (removes indices too)
    } else {
      const existingCount = await BloodBankModel.countDocuments();
      if (existingCount > 0) {
        return res.json({ message: 'Blood banks already exist', count: existingCount });
      }
    }
    
    const sampleBloodBanks = [
      {
        name: 'Central Blood Bank',
        address: 'MG Road, Hyderabad, Telangana 500001',
        latitude: 17.3850,
        longitude: 78.4867,
        contactNumber: '+91-40-23456789',
        email: 'central@bloodbank.org',
        bloodInventory: { 'A+': 25, 'A-': 8, 'B+': 30, 'B-': 5, 'O+': 40, 'O-': 10, 'AB+': 15, 'AB-': 3 }
      },
      {
        name: 'City Hospital Blood Center',
        address: 'Banjara Hills, Hyderabad, Telangana 500034',
        latitude: 17.4156,
        longitude: 78.4347,
        contactNumber: '+91-40-98765432',
        email: 'cityhospital@bloodbank.org',
        bloodInventory: { 'A+': 20, 'A-': 5, 'B+': 18, 'B-': 3, 'O+': 35, 'O-': 7, 'AB+': 10, 'AB-': 2 }
      },
      {
        name: 'Red Cross Blood Bank',
        address: 'Secunderabad, Telangana 500003',
        latitude: 17.4399,
        longitude: 78.4983,
        contactNumber: '+91-40-27890123',
        email: 'redcross@bloodbank.org',
        bloodInventory: { 'A+': 15, 'A-': 4, 'B+': 22, 'B-': 6, 'O+': 28, 'O-': 12, 'AB+': 8, 'AB-': 4 }
      },
      {
        name: 'LifeLine Blood Bank',
        address: 'Kukatpally, Hyderabad, Telangana 500072',
        latitude: 17.4947,
        longitude: 78.3996,
        contactNumber: '+91-40-23456123',
        email: 'lifeline@bloodbank.org',
        bloodInventory: { 'A+': 30, 'A-': 10, 'B+': 25, 'B-': 8, 'O+': 45, 'O-': 15, 'AB+': 12, 'AB-': 5 }
      },
      {
        name: 'Gandhi Hospital Blood Bank',
        address: 'Musheerabad, Hyderabad, Telangana 500003',
        latitude: 17.4062,
        longitude: 78.4802,
        contactNumber: '+91-40-27891234',
        email: 'gandhi@bloodbank.org',
        bloodInventory: { 'A+': 18, 'A-': 6, 'B+': 20, 'B-': 4, 'O+': 32, 'O-': 8, 'AB+': 10, 'AB-': 3 }
      },
      {
        name: 'Apollo Blood Bank',
        address: 'Jubilee Hills, Hyderabad, Telangana 500033',
        latitude: 17.4320,
        longitude: 78.4070,
        contactNumber: '+91-40-23607070',
        email: 'apollo@bloodbank.org',
        bloodInventory: { 'A+': 35, 'A-': 12, 'B+': 28, 'B-': 7, 'O+': 50, 'O-': 18, 'AB+': 14, 'AB-': 6 }
      }
    ];
    
    await BloodBankModel.insertMany(sampleBloodBanks);
    res.json({ message: 'Sample blood banks created', count: sampleBloodBanks.length });
  } catch (err) {
    console.error('Seed blood banks error:', err);
    res.status(500).json({ message: 'Error seeding blood banks' });
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