/**
 * QuickBite - Google Apps Script Web App
 * Real-time synchronization for Canteen Orders and Menu
 * 
 * SETUP INSTRUCTIONS:
 * 1. Open Google Sheets (https://sheets.new) and create a new Spreadsheet.
 * 2. Click Extensions > Apps Script.
 * 3. Replace all code in Code.gs with this entire file.
 * 4. Click Deploy > New deployment.
 * 5. Select type: "Web app".
 * 6. Set Description: "QuickBite Webhook".
 * 7. Set "Execute as": "Me (<your email>)".
 * 8. Set "Who has access": "Anyone" (crucial for webhook to receive requests).
 * 9. Click Deploy, authorize access, and copy the Web App URL.
 * 10. Paste the Web App URL into your .env file as SHEETS_WEBHOOK_URL.
 */

// Helper to ensure Menu sheet exists with proper headers
function getOrCreateMenuSheet(ss) {
  var sheet = ss.getSheetByName("Menu");
  var headers = [
    "Name",
    "Category",
    "Price",
    "Prep Time",
    "Stock",
    "Veg",
    "Image URL",
    "Available"
  ];

  if (!sheet) {
    sheet = ss.insertSheet("Menu");
    sheet.appendRow(headers);
    var headerRange = sheet.getRange(1, 1, 1, headers.length);
    headerRange.setFontWeight("bold");
    headerRange.setBackground("#F97316");
    headerRange.setFontColor("#FFFFFF");
    sheet.setFrozenRows(1);
  } else if (sheet.getLastRow() === 0) {
    sheet.appendRow(headers);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight("bold").setBackground("#F97316").setFontColor("#FFFFFF");
    sheet.setFrozenRows(1);
  }
  return sheet;
}

// Helper to ensure Orders sheet exists with proper headers
function getOrCreateOrdersSheet(ss) {
  var sheet = ss.getSheetByName("Orders");
  var headers = [
    "Order ID",
    "Date",
    "Time Placed",
    "Student Name",
    "Department",
    "Items",
    "Total",
    "Slot",
    "Token",
    "Status",
    "Station Status",
    "Last Updated"
  ];

  if (!sheet) {
    sheet = ss.insertSheet("Orders");
    sheet.appendRow(headers);
    var headerRange = sheet.getRange(1, 1, 1, headers.length);
    headerRange.setFontWeight("bold");
    headerRange.setBackground("#F97316");
    headerRange.setFontColor("#FFFFFF");
    sheet.setFrozenRows(1);
  } else if (sheet.getLastRow() === 0) {
    sheet.appendRow(headers);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight("bold").setBackground("#F97316").setFontColor("#FFFFFF");
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/**
 * Handle GET requests:
 * - action=menu: returns the Menu tab rows as JSON array
 */
function doGet(e) {
  try {
    var action = (e && e.parameter && e.parameter.action) ? e.parameter.action.toLowerCase() : "";
    var ss = SpreadsheetApp.getActiveSpreadsheet();

    if (action === "menu") {
      var sheet = getOrCreateMenuSheet(ss);
      var lastRow = sheet.getLastRow();
      var menu = [];

      if (lastRow > 1) {
        var values = sheet.getRange(2, 1, lastRow - 1, 8).getValues();
        for (var i = 0; i < values.length; i++) {
          var row = values[i];
          var name = String(row[0] || "").trim();
          if (!name) continue; // Skip blank rows

          var category = String(row[1] || "Snacks").trim();
          var price = Number(row[2]) || 0;
          var prepTime = Number(row[3]) || 5;
          var stock = Number(row[4]) || 0;
          var vegStr = String(row[5] || "yes").trim().toLowerCase();
          var veg = (vegStr === "yes" || vegStr === "true" || vegStr === "1") ? 1 : 0;
          var image = String(row[6] || "").trim();
          var availStr = String(row[7] || "yes").trim().toLowerCase();
          var available = (availStr === "yes" || availStr === "true" || availStr === "1") ? 1 : 0;

          menu.push({
            name: name,
            category: category,
            price: price,
            prep_time: prepTime,
            stock: stock,
            veg: veg,
            image: image,
            available: available
          });
        }
      }

      return ContentService.createTextOutput(JSON.stringify({
        success: true,
        count: menu.length,
        menu: menu
      })).setMimeType(ContentService.MimeType.JSON);
    }

    return ContentService.createTextOutput(JSON.stringify({
      status: "online",
      service: "QuickBite Google Apps Script Webhook",
      message: "Ready to receive order sync and menu events"
    })).setMimeType(ContentService.MimeType.JSON);

  } catch (error) {
    return ContentService.createTextOutput(JSON.stringify({
      success: false,
      error: error.toString()
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

/**
 * Handle POST requests:
 * - action="update_menu_item": updates stock, availability, or full item in the Menu tab
 * - action="upsert" (or default): updates or appends order in the Orders tab
 */
function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.tryLock(10000); // Wait up to 10s for concurrent writes

  try {
    if (!e || !e.postData || !e.postData.contents) {
      return ContentService.createTextOutput(JSON.stringify({
        success: false,
        error: "No post data received"
      })).setMimeType(ContentService.MimeType.JSON);
    }

    var data = JSON.parse(e.postData.contents);
    var ss = SpreadsheetApp.getActiveSpreadsheet();

    // 1. UPDATE MENU ITEM IN "Menu" TAB
    if (data.action === "update_menu_item") {
      var menuSheet = getOrCreateMenuSheet(ss);
      var itemName = String(data.name || "").trim();
      if (!itemName) {
        return ContentService.createTextOutput(JSON.stringify({
          success: false,
          error: "Item name is required for menu update"
        })).setMimeType(ContentService.MimeType.JSON);
      }

      var lastRow = menuSheet.getLastRow();
      var foundRow = -1;

      if (lastRow > 1) {
        var names = menuSheet.getRange(2, 1, lastRow - 1, 1).getValues();
        for (var i = 0; i < names.length; i++) {
          if (String(names[i][0]).trim().toLowerCase() === itemName.toLowerCase()) {
            foundRow = i + 2;
            break;
          }
        }
      }

      if (foundRow > 0) {
        // Update specific columns if provided
        if (data.stock !== undefined) {
          menuSheet.getRange(foundRow, 5).setValue(Number(data.stock) || 0); // Column 5: Stock
        }
        if (data.available !== undefined) {
          var isAvail = (data.available === true || data.available === 1 || String(data.available).toLowerCase() === "yes");
          menuSheet.getRange(foundRow, 8).setValue(isAvail ? "yes" : "no"); // Column 8: Available
        }
        if (data.price !== undefined) {
          menuSheet.getRange(foundRow, 3).setValue(Number(data.price) || 0);
        }
        if (data.prep_time !== undefined) {
          menuSheet.getRange(foundRow, 4).setValue(Number(data.prep_time) || 0);
        }
        if (data.category !== undefined) {
          menuSheet.getRange(foundRow, 2).setValue(String(data.category));
        }
        if (data.veg !== undefined) {
          var isVeg = (data.veg === true || data.veg === 1 || String(data.veg).toLowerCase() === "yes");
          menuSheet.getRange(foundRow, 6).setValue(isVeg ? "yes" : "no");
        }
        if (data.image !== undefined) {
          menuSheet.getRange(foundRow, 7).setValue(String(data.image));
        }

        return ContentService.createTextOutput(JSON.stringify({
          success: true,
          action: "updated",
          name: itemName,
          row: foundRow
        })).setMimeType(ContentService.MimeType.JSON);
      } else {
        // If not found in sheet, append row
        var isAvail = (data.available === true || data.available === 1 || String(data.available).toLowerCase() === "yes");
        var isVeg = (data.veg === true || data.veg === 1 || String(data.veg).toLowerCase() === "yes");
        var newRow = [
          itemName,
          data.category || "Snacks",
          Number(data.price) || 0,
          Number(data.prep_time) || 0,
          Number(data.stock) || 0,
          isVeg ? "yes" : "no",
          data.image || "",
          isAvail ? "yes" : "no"
        ];
        menuSheet.appendRow(newRow);

        return ContentService.createTextOutput(JSON.stringify({
          success: true,
          action: "inserted",
          name: itemName,
          row: menuSheet.getLastRow()
        })).setMimeType(ContentService.MimeType.JSON);
      }
    }

    // 2. ORDERS UPSERT (default action="upsert")
    var orderSheet = getOrCreateOrdersSheet(ss);
    var orderId = String(data.orderId || "");
    var date = data.date || Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");
    var timePlaced = data.timePlaced || Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "HH:mm:ss");
    var studentName = data.studentName || "Student";
    var department = data.department || "Other";
    var items = data.items || "";
    var total = Number(data.total || 0);
    var slot = data.slot || "";
    var token = data.token || "";
    var status = data.status || "Placed";
    var stationStatus = data.stationStatus || "";
    var lastUpdated = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm:ss");

    var rowValues = [
      orderId,
      date,
      timePlaced,
      studentName,
      department,
      items,
      total,
      slot,
      token,
      status,
      stationStatus,
      lastUpdated
    ];

    var lastRow = orderSheet.getLastRow();
    var foundRowIndex = -1;

    if (lastRow > 1) {
      var ids = orderSheet.getRange(2, 1, lastRow - 1, 1).getValues();
      for (var i = 0; i < ids.length; i++) {
        if (String(ids[i][0]) === orderId) {
          foundRowIndex = i + 2;
          break;
        }
      }
    }

    if (foundRowIndex > 0) {
      orderSheet.getRange(foundRowIndex, 1, 1, rowValues.length).setValues([rowValues]);
      return ContentService.createTextOutput(JSON.stringify({
        success: true,
        action: "updated",
        orderId: orderId,
        row: foundRowIndex
      })).setMimeType(ContentService.MimeType.JSON);
    } else {
      orderSheet.appendRow(rowValues);
      return ContentService.createTextOutput(JSON.stringify({
        success: true,
        action: "inserted",
        orderId: orderId,
        row: orderSheet.getLastRow()
      })).setMimeType(ContentService.MimeType.JSON);
    }

  } catch (error) {
    return ContentService.createTextOutput(JSON.stringify({
      success: false,
      error: error.toString()
    })).setMimeType(ContentService.MimeType.JSON);
  } finally {
    lock.releaseLock();
  }
}
