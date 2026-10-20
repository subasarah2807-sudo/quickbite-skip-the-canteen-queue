# 🍔 QuickBite - Skip the Canteen Queue

> **A smart, prep-time-aware food ordering & queue-skipping web application built for college canteens.**

QuickBite eliminates long canteen queues during lunch rush hours by introducing **10-minute capacity-constrained pickup slots**, **two-level FIFO kitchen prioritization**, **one-time QR tokens**, **Google Sheets & CSV data sources**, and **real-time kitchen & customer synchronization**.

---

## ⚡ Tech Stack

- **Frontend**: React 18 (Vite) + Tailwind CSS + Framer Motion + Recharts + Lucide Icons + Canvas-Confetti
- **Backend**: Node.js + Express + SQLite (`better-sqlite3` with WAL mode & atomic transactions) + Socket.io + `node-cron` + `qrcode`
- **Data Integrations**: Google Sheets Webhook (via Google Apps Script `doGet` / `doPost`) + CSV Import & Export + Manual Entry
- **Real-Time Engine**: Socket.io rooms for live student order tracking, item unavailability swap alerts, and staff kitchen queue synchronization.
- **Auto-Expiry**: `node-cron` job running every minute to free up stock & slot capacity for no-show orders.

---

## 🚀 Single-Command Quickstart

### 1. Prerequisites
- **Node.js** v18+ (tested up to Node.js v24)
- **npm** v9+

### 2. Setup & Run
From the root project directory:
```bash
# 1. Install root dependencies (concurrently)
npm install

# 2. Run both frontend and backend concurrently with a single command
npm run dev
```

- **Frontend Client**: [http://localhost:5173](http://localhost:5173)
- **Backend API Server**: [http://localhost:5000](http://localhost:5000)

---

## 🌟 Zero-Data Clean Start Behavior

QuickBite starts in a clean production-ready state:
- **Zero Orders**: Starts with 0 active or historical orders.
- **Zero Students**: No dummy student accounts. Students create a session on first login.
- **Empty Menu by Default**: No hardcoded dummy food items. The menu is populated dynamically via **CSV Import**, **Google Sheets Menu Sync**, or the chef's **Add Menu Item** manual form.
- **Seeded Chef Account**: The only seeded account is the canteen chef (`chef` / `chef123`).
- **Friendly Empty States**:
  - **Student View**: Displays a friendly *"Menu is being updated — Check back in a few minutes or ask the canteen chef to load today's fresh menu"* banner when no items are available.
  - **Chef Dashboard**: Displays *"No orders yet — New student orders will appear here automatically in real time"* when the kitchen FIFO queue is clear.

---

## 🔐 Separate Logins & Role Security

QuickBite features strict separation between students and kitchen staff:

### 🎓 1. Student Login
- **URL**: Landing page ([http://localhost:5173](http://localhost:5173)) -> Click **"I'm a Student"**
- **Authentication**: **No password required**. Simply enter:
  - **Full Name** (e.g. `Karan Rao`)
  - **Department** (dropdown: `CSE`, `IT`, `ECE`, `EEE`, `MECH`, `CIVIL`, `MCA`, `MBA`, `Other`)
- **Behavior**: Case-insensitive find or create. Displays `"Hi, <name>"` and the department badge in the top header.
- **Security**: **Students cannot access chef/kitchen pages**. Direct navigation or deep links to `/chef-login` or kitchen routes are blocked.

### 👨‍🍳 2. Chef / Staff Login
- **URL**: [http://localhost:5173/chef-login](http://localhost:5173/chef-login) or Landing page -> Click **"I'm the Chef"**
- **Credentials**:
  - **Username**: `chef`
  - **Password**: `chef123`
- **Security**: Password stored as a salted **bcrypt** hash in SQLite. Returns a signed **JWT** token. All chef routes (`/api/orders/queue`, `/api/orders/cancelled`, `/api/orders/:id/status`, `/api/orders/verify-token`, `/api/stats`, `/api/menu`) are protected with `requireChef` middleware.
- **Logout**: 1-click Logout button in the header and staff sidebar.

---

## 📊 Google Sheets Integration (Orders + Menu)

QuickBite integrates with Google Sheets via a Google Apps Script web app without external paid dependencies.

### Step-by-Step Setup:
1. **Create Google Sheet**:
   - Go to [Google Sheets](https://sheets.new) and create a new blank spreadsheet.
   - Name it `QuickBite Canteen`.
2. **Open Apps Script**:
   - Click **Extensions** > **Apps Script** in the top menu.
3. **Paste the Script**:
   - Delete any code in the editor.
   - Copy the entire contents of [`server/google-apps-script.gs`](server/google-apps-script.gs) and paste it into the editor.
   - Click **Save** (floppy disk icon or Ctrl+S).
4. **Deploy as Web App**:
   - In the top right, click **Deploy** > **New deployment**.
   - Click the gear icon next to "Select type" and choose **Web app**.
   - Set Description: `QuickBite Webhook`.
   - Set **Execute as**: `Me (your email)`.
   - Set **Who has access**: `Anyone`. *(Crucial: allows the backend to communicate with the sheet)*.
   - Click **Deploy** and grant standard Google permissions when prompted.
5. **Configure `.env`**:
   - Copy the generated **Web app URL** (starts with `https://script.google.com/macros/s/...`).
   - Create or edit `server/.env`:
     ```env
     PORT=5000
     JWT_SECRET=quickbite-super-secret-jwt-key-2026
     SHEETS_WEBHOOK_URL=https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec
     ```
6. **Sheet Structure & Auto-Creation**:
   The script automatically initializes and formats two tabs if they do not exist:
   - **`Orders` Tab**: `Order ID | Date | Time Placed | Student Name | Department | Items | Total | Slot | Token | Status | Last Updated`
   - **`Menu` Tab**: `Name | Category | Price | Prep Time | Stock | Veg | Image URL | Available`

*Note: If `SHEETS_WEBHOOK_URL` is empty, the app runs offline seamlessly and skips syncing.*

---

## 📁 CSV Import & Export Capabilities

The Chef Console provides full CSV data management under **Menu & Stock Control** and the **Kitchen FIFO Queue**:

### 1. Import Menu (CSV)
- Click **"Import Menu (CSV)"** to upload any standard CSV file containing canteen food items.
- Expected Columns: `Name, Category, Price, Prep Time, Stock, Veg, Image URL, Available`.
- **Validation**: Normalizes categories (`Breakfast`, `Meals`, `Snacks`, `Drinks`), parses veg flags (`yes/no/1/0`), updates existing items if matched by name, or inserts new items.
- Displays a clear summary alert: e.g. `"12 added, 3 updated, 1 skipped"`.

### 2. Download Menu CSV Template
- Click **"Download Menu CSV template"** in the Menu & Stock tab.
- Automatically generates and downloads a clean, pre-filled `quickbite_menu_template.csv` ready for editing in Excel or Google Sheets.

### 3. Add Menu Item (Manual Entry)
- Click **"Add Menu Item"** to open an intuitive modal form.
- Enter Name, Category, Price, Prep Time, Stock, Veg/Non-Veg, Image URL, and Availability.
- Instantly adds the item to SQLite and writes it back to the Google Sheet Menu tab.

### 4. Export Orders (CSV)
- Available in the **FIFO Orders Queue** and **Analytics** headers.
- Choose date filter: **Today's Orders** or **All Orders**.
- Click **"Export Orders (CSV)"** to instantly download an RFC 4180-compliant CSV with:
  `Order ID, Date, Time Placed, Student Name, Department, Items, Total, Slot, Status, Last Updated`.

---

## 🎯 Complete Feature Matrix

### 🎓 Student Features
1. **Interactive Menu**: Food cards with images, prices, prep times, veg/non-veg tags, category filters (*Breakfast, Meals, Snacks, Drinks*), and instant search. Unavailable items display a greyed "Sold Out" badge.
2. **Smart Cart**: Live pricing, prep time calculation, and strict enforcement of the **5 items per order limit**.
3. **Capacity-Aware 10-Minute Slot Picker**: Visual capacity bars (Green `<50%`, Yellow `50-89%`, Red `≥90%` or Full). Slots that cannot accommodate an order's prep time or are full are disabled with a *"Full - try next slot"* nudge. Past slots are hidden according to the canteen clock.
4. **Order Confirmation & One-Time QR Token**: Instant confirmation modal featuring confetti fireworks, a high-contrast QR code, and unique token code (`QB-XXXX`).
5. **My Orders Live Progress Stepper**: Real-time 4-stage tracking (*Placed > Preparing > Ready > Collected*), live countdown timer to the pickup slot, and a **Cancel button** (allowed until 10 minutes before the pickup slot).
6. **Student Cancel Reflection**: When a student cancels an order, slot capacity is freed, stock is restored, a live Socket.io event `"order:cancelled"` is emitted to the chef dashboard, and the Google Sheet row updates to *"Cancelled"*. If the chef is already preparing the order, cancellation is blocked with *"Order already being prepared"*.
7. **Live Out-of-Stock Swap Alert**: If canteen staff marks an item unavailable, students with pending orders for that item receive a real-time modal with 1-click swap alternatives or cancellation.
8. **Global Live Status Toasts**: Real-time toast alerts notify students when kitchen moves their order status (*Placed > Preparing > Ready > Collected*).

### 👨‍🍳 Staff Kitchen Features
1. **Two-Level FIFO Kitchen Queue**: Orders strictly ordered by **Slot Time first**, then **Order Creation Time**. The top card is highlighted as **"NEXT TO PREPARE"** with one-click status transitions (*Start Preparing > Mark Ready > Mark Collected*).
2. **Student Identity on Every Card**: Student **Name** and **Department** (e.g. `Karan Rao (CSE)`) are prominently displayed on all order cards.
3. **Live Student Cancel Alerts & Cancelled Log**:
   - Instant red toast alert: `"Order #<id> cancelled by <student name> (<dept>)"`.
   - Order automatically removed from active FIFO queue.
   - Logged in the **"Cancelled Orders"** tab with student name, department, items, and cancellation timestamp.
   - Stats counters automatically update with **Cancelled** orders.
4. **Google Sheets Menu Sync & Live Status**:
   - 🔄 **"Sync Menu from Google Sheet"** button reads the `Menu` tab and syncs items directly into SQLite.
   - Status pill: 🟢 **"Synced to Google Sheets"** / 🟡 **"Sync pending (X)"**.
5. **QR Scan & Token Verification**:
   - 📷 **"Scan QR" Camera Button**: Placed directly next to the token entry box, opens the device camera viewfinder using the `html5-qrcode` library. Automatically detects student pickup QR codes and dispatches tokens to `POST /api/orders/verify-token`.
   - ⌨️ **Manual Token Entry Fallback**: Fast manual entry of 4-digit codes (`QB-XXXX`).
   - 🔐 **Camera Access Requirement**: Browser camera permissions require a secure context (**HTTPS** or **`localhost`** / `127.0.0.1`). When running remotely across devices on a local network, use manual token entry as the fallback unless serving over HTTPS.
   - 🏷️ **Clear Result Messages**:
     - ✅ **Success**: Marks order *Collected* and records food handed over.
     - ⚠️ **Already Used**: Rejects previously collected orders with timestamp.
     - ⚠️ **Expired**: Rejects no-show expired orders.
     - ⚠️ **Invalid / Fake**: Rejects unregistered tokens.
6. **Menu, Prep Time & Stock Control**:
   - **Per-Item Preparation Time**: Each item has its own dedicated prep time (1–60 min, whole numbers). The chef can edit prep time inline on the dashboard and save it, which writes to SQLite, updates Google Sheets, and broadcasts live to student menu cards ("Ready in X min").
   - **Prep-Time-Aware Capacity**: Order load = $\sum (\text{item prep time} \times \text{quantity})$. If an order cannot fit within a slot's remaining prep minutes, it is blocked with *"Not enough time left in this slot, try the next one"*.
   - Toggle availability and increase/decrease real-time kitchen inventory (+/-5). Triggers live alerts to affected students and syncs changes to Google Sheets.
7. **Peak-Hour Heatmap / Bar Chart**: Built with **Recharts** displaying orders and kitchen booked prep minutes per slot today.
8. **Kitchen Stats Cards**: Total Orders, Pending in Kitchen, Collected, Cancelled, Expired No-Shows, and Average Prep Time per order.
9. **Slot Settings**: Adjust maximum cumulative kitchen minutes per 10-minute window (default: 20 min).

---

## 🔄 Concurrency design: FIFO + parallel station workers

QuickBite utilizes a high-throughput **Producer-Consumer architecture** to eliminate kitchen bottlenecks:

1. **Students as Producers**:
   - Students act as producers, submitting orders with multiple items across different culinary categories.
   - On submission, an atomic SQLite transaction partitions items into station parts (`OrderParts`):
     - 🥞 **Tiffin Counter**: Breakfast items (e.g. Masala Dosa, Idli)
     - 🍱 **Meals Counter**: Meal items (e.g. Veg Thali, Biryani)
     - 🥟 **Snacks Counter**: Snack items (e.g. Samosa, Puff)
     - ☕ **Drinks Counter**: Beverage items (e.g. Masala Chai, Filter Coffee)
   - Slot capacity checks, stock validation & decrementing, and part creation are executed within a single atomic SQLite transaction to prevent race conditions or double-booking.

2. **FIFO per Station Queue**:
   - Each station maintains its own independent FIFO queue, prioritized by **Pickup Slot Time first**, then **Order Creation Time**.
   - Within each station, the oldest part is always prepared first.

3. **Parallel Station Workers as Consumers**:
   - Station workers run concurrently as independent consumers.
   - Because workers operate concurrently on separate queues, quick items (like a 2-minute tea at the Drinks Counter) are processed immediately and are **never stuck behind long items** (like a 6-minute biryani at the Meals Counter).
   - Atomic database transactions ensure two workers can never claim the same part.

4. **Order Status Roll-Up**:
   - The overall order transitions to **"Preparing"** as soon as any station worker begins preparing a part.
   - The overall order transitions to **"Ready"** only when **ALL** of its constituent station parts are marked "Ready".
   - The student's live tracking view displays fine-grained progress across stations (e.g. `Drinks: Ready | Meals: Preparing`).

---

## 🔒 Concurrency & Reliability
- **Atomic Transactions**: SQLite transactions (`better-sqlite3`) ensure that slot capacity checks, stock validation, decrementing, and order insertion happen atomically without race conditions.
- **Server Clock Only**: Slot validation and past slot filtering rely strictly on the canteen server clock.
- **No-Show Auto-Expiry**: Orders past their slot grace window automatically expire via `node-cron`, immediately restocking ingredients and freeing kitchen slot capacity.
