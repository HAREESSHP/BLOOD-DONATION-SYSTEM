self.addEventListener('push', function(event) {
  const data = event.data ? event.data.json() : {};
  const title = data.title || 'Blood Donation Alert';
  const options = {
    body: data.body || 'A blood request needs your help!',
    icon: '/favicon.ico',
    badge: '/favicon.ico',
    data: data.url || '/',
    actions: [
      { action: 'open', title: 'View Request' }
    ]
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  if (event.notification.data) {
    event.waitUntil(clients.openWindow(event.notification.data));
  }
});