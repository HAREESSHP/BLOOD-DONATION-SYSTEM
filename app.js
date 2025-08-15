// Utility: Register Service Worker & Push
function registerPush() {
  if ('serviceWorker' in navigator && 'PushManager' in window) {
    navigator.serviceWorker.register('/sw.js').then(reg => {
      Notification.requestPermission().then(permission => {
        if (permission === 'granted') {
          reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array('BOqS9zLT-USQBdiBka2zgy--Qi0PKO2xFiGRQdio2NF7-CJdd6WKVgu206ukLXGQPudR7NnF7yvkBteGIJ23Ov8')
          }).then(sub => {
            window.donorPushSubscription = sub.toJSON();
          });
        }
      });
    });
  }
}
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding)
      .replace(/-/g, '+')
      .replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
      outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

// Show/hide modals for forms
window.showDonorForm = () => { document.getElementById('donorModal').style.display = 'block'; };
window.closeDonorForm = () => { document.getElementById('donorModal').style.display = 'none'; };
window.showReceiverForm = () => { document.getElementById('receiverModal').style.display = 'block'; };
window.closeReceiverForm = () => { document.getElementById('receiverModal').style.display = 'none'; };

// --- Donor Registration ---
document.getElementById('donorForm').onsubmit = async function(e) {
  e.preventDefault();
  const donorData = {
    name: this.donorName.value,
    email: this.donorEmail.value,
    bloodGroup: this.bloodGroup.value,
    phone: this.donorPhone.value,
    location: this.donorLocation.value,
    notificationsEnabled: this.enableNotifications?.checked,
    registeredAt: new Date().toISOString(),
    isAvailable: true,
    pushSubscription: window.donorPushSubscription || null,
  };
  const res = await fetch('/api/donors', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(donorData)
  });
  const data = await res.json();
  if (res.ok) {
    closeDonorForm();
    alert('Donor Registered!');
  } else {
    alert(data.message || 'Error');
  }
};
// --- Request Blood ---
document.getElementById('receiverForm').onsubmit = async function(e) {
  e.preventDefault();
  const reqData = {
    requesterName: this.receiverName.value,
    email: this.receiverEmail.value,
    bloodGroup: this.requiredBloodGroup.value,
    phone: this.receiverPhone.value,
    hospitalName: this.hospitalName.value,
    hospitalLocation: this.hospitalLocation.value,
    urgency: this.urgency.value,
    notes: this.notes.value,
    requestedAt: new Date().toISOString(),
    status: 'pending',
  };
  const res = await fetch('/api/requests', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(reqData)
  });
  const data = await res.json();
  if (res.ok) {
    closeReceiverForm();
    alert('Blood request submitted!');
    pollRequestStatus(data._id, reqData.email);
  } else {
    alert(data.message || 'Error');
  }
};
// --- Poll for match ---
function pollRequestStatus(requestId, receiverEmail) {
  const interval = setInterval(() => {
    fetch(`/api/requests/${requestId}`)
      .then(res => res.json())
      .then(request => {
        if (request.status === 'accepted' && request.donorDetails) {
          clearInterval(interval);
          alert(`Donor found: ${request.donorDetails.name}, ${request.donorDetails.phone}`);
          fetchMessages(receiverEmail);
        }
      });
  }, 5000);
}
// --- In-app message feed ---
function fetchMessages(receiverId) {
  fetch(`/api/messages/${receiverId}`)
    .then(res => res.json())
    .then(msgs => {
      const feed = document.getElementById('messageFeed');
      if (!feed) return;
      feed.innerHTML = msgs.map(msg =>
        `<div><b>${msg.sender}:</b> ${msg.content} <i>${new Date(msg.sentAt).toLocaleString()}</i></div>`
      ).join('');
    });
}

registerPush();