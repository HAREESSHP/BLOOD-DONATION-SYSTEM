# BloodConnect

A blood donation platform that connects donors with recipients in need, featuring push notifications and real-time updates.

## Features

- **Donor Registration**: Users can register as blood donors with location and availability
- **Blood Requests**: Recipients can submit urgent blood requests
- **Push Notifications**: Real-time alerts for matching donors
- **Location-based Matching**: Connect donors and recipients in the same area
- **PWA Support**: Progressive Web App with offline capabilities

## Setup

### Prerequisites

- Node.js (v14 or higher)
- MongoDB database (local or Atlas)
- VAPID keys for push notifications

### Installation

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd bloodconnect
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Environment Configuration**
   Create a `.env` file in the root directory:
   ```env
   MONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net/bloodconnect
   VAPID_PUBLIC_KEY=your_public_vapid_key
   VAPID_PRIVATE_KEY=your_private_vapid_key
   VAPID_CONTACT_EMAIL=mailto:admin@bloodconnect.com
   PORT=5500
   ```

4. **Generate VAPID Keys** (if you don't have them)
   ```bash
   npx web-push generate-vapid-keys
   ```

5. **Start the server**
   ```bash
   npm start
   # or for development with auto-restart:
   npm run dev
   ```

## API Endpoints

### Donors
- `POST /api/donors` - Register a new donor
- `GET /api/donors` - Get all donors

### Blood Requests
- `POST /api/requests` - Submit a blood request
- `GET /api/requests` - Get all requests
- `GET /api/requests/:id` - Get specific request

### Messages
- `GET /api/messages/:receiverId` - Get messages for a recipient

## Project Structure

```
bloodconnect/
├── server.js          # Express server with MongoDB
├── app.js            # Client-side JavaScript
├── index.html        # Main application interface
├── styles.css        # Application styling
├── sw.js            # Service Worker for PWA
├── manifest.json     # PWA manifest
├── package.json      # Dependencies and scripts
└── README.md        # This file
```

## Security Notes

- **Never commit sensitive data** like MongoDB credentials or VAPID keys
- Use environment variables for all configuration
- Consider implementing user authentication for production use
- Validate all input data on the server side

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## License

MIT License - see LICENSE file for details
