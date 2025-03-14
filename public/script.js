console.log('hello js');

let qrFetchTimer = null;

// Function to show toast notifications
function showToast(message, type = 'success') {
    Swal.fire({
        toast: true,
        position: 'top-end',
        icon: type,
        title: message,
        showConfirmButton: false,
        timer: 3000,
        timerProgressBar: true,
        didOpen: (toast) => {
            toast.addEventListener('mouseenter', Swal.stopTimer);
            toast.addEventListener('mouseleave', Swal.resumeTimer);
        }
    });
}

// Function to show and hide the loading spinner
function showLoadingSpinner(show) {
    const spinner = document.getElementById('loading-spinner');
    if (show) {
        spinner.style.display = 'flex';
    } else {
        spinner.style.display = 'none';
    }
}

// Fetch QR Code
async function fetchQRCode() {
    try {
        // Clear existing timer
        if (qrFetchTimer) {
            clearTimeout(qrFetchTimer);
            qrFetchTimer = null;
        }

        console.log('Fetching QR code...');
        const response = await fetch("/qrcode?t=" + Date.now(), {
            headers: {
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache'
            }
        });
        
        const data = await response.json();
        console.log('QR code status:', data.status);
        
        const qrElement = document.getElementById("qr-code-image");
        const signoutBtn = document.getElementById("btn-signout");
        const refreshBtn = document.getElementById("btn-refresh");
        const mainContent = document.getElementById("main-content");
        const qrSection = document.getElementById("qr-section");
        
        refreshBtn.disabled = false;
        
        switch (data.status) {
            case 'authenticated':
                qrSection.classList.add("hidden");
                signoutBtn.classList.remove("hidden");
                mainContent.classList.remove("hidden");
                showToast('Authenticated successfully!', 'success');
                break;
                
            case 'waiting_for_scan':
                qrSection.classList.remove("hidden");
                signoutBtn.classList.add("hidden");
                mainContent.classList.add("hidden");
                qrElement.innerHTML = `
                    <img src="${data.qrCode}" alt="QR Code" class="neon-border" style="max-width: 100%; height: auto;">
                `;
                // Refresh QR code every 20 seconds
                qrFetchTimer = setTimeout(fetchQRCode, 20000);
                break;
                
            case 'loading':
            case 'initializing':
                qrSection.classList.remove("hidden");
                signoutBtn.classList.add("hidden");
                mainContent.classList.add("hidden");
                qrElement.innerHTML = `
                    <div class="loading-qr">
                        <i class="fas fa-spinner fa-spin"></i>
                        <p>Generating QR Code...</p>
                    </div>
                `;
                // Retry after 2 seconds
                qrFetchTimer = setTimeout(fetchQRCode, 2000);
                break;
        }
    } catch (error) {
        console.error('Error fetching QR code:', error);
        showToast('Error fetching QR code', 'error');
        // Retry after 5 seconds on error
        qrFetchTimer = setTimeout(fetchQRCode, 5000);
    }
}

// Parse Excel file
function parseExcel(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const data = new Uint8Array(e.target.result);
      const workbook = XLSX.read(data, { type: "array" });
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const json = XLSX.utils.sheet_to_json(sheet, { header: 1 });

      // Extract data (assuming first row is headers)
      const headers = json[0];
      const rows = json.slice(1);

      resolve({ headers, rows });
    };
    reader.onerror = (e) => reject(e);
    reader.readAsArrayBuffer(file);
  });
}

// Add this function after the existing functions
function addResult(message, isSuccess = true, timestamp = new Date()) {
  const resultsList = document.getElementById('results');
  const li = document.createElement('li');
  li.className = isSuccess ? 'success' : 'error';
  
  // Format the timestamp with AM/PM
  const timeStr = timestamp.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true // This enables AM/PM format
  });
  
  // Format the message with fixed-width spacing
  li.innerHTML = `[${timeStr}] ${message}`;
  
  // Add to top of list instead of bottom
  resultsList.insertBefore(li, resultsList.firstChild);
  li.scrollIntoView({ behavior: 'smooth' });
}

// Send messages
async function sendMessages() {
  // Clear previous results at the start
  document.getElementById('results').innerHTML = '';

  const fileInput = document.getElementById("excel-file");
  const message = document.getElementById("message").value;
  const minInterval = parseFloat(document.getElementById("min-interval").value);
  const maxInterval = parseFloat(document.getElementById("max-interval").value);

  if (!fileInput.files.length || !message) {
    showToast("Please upload a file and enter a message.", 'warning');
    return;
  }
  if (isNaN(minInterval) || isNaN(maxInterval) || minInterval > maxInterval) {
    showToast("Please provide a valid interval range.", 'warning');
    return;
  }

  // Generate a random interval in seconds between min and max
  const interval =
    Math.floor(Math.random() * (maxInterval - minInterval + 1)) + minInterval;

  // Parse Excel file
  const { headers, rows } = await parseExcel(fileInput.files[0]);

  // Validate headers
  if (
    !headers.includes("WhatsApp Number(with country code)") ||
    !headers.includes("First Name") ||
    !headers.includes("Last Name")
  ) {
    showToast("Invalid Excel file format. Required columns: WhatsApp Number, First Name, Last Name.", 'error');
    return;
  }

  // Prepare data
  const recipients = rows.map((row) => ({
    number: row[headers.indexOf("WhatsApp Number(with country code)")],
    firstName: row[headers.indexOf("First Name")],
    lastName: row[headers.indexOf("Last Name")],
  }));

  // Send data to backend, including the randomly generated interval
  try {
    // Clear previous results
    document.getElementById('results').innerHTML = '';

    const response = await fetch("/send-messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recipients, message, interval }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      addResult(errorData.error || "Failed to send messages.", false);
      showToast(errorData.error || "Failed to send messages.", 'error');
      throw new Error(errorData.error || "Failed to send messages.");
    }

    const result = await response.json();
    
    // Check if result is an array, if not, just show a single success message
    if (Array.isArray(result)) {
      result.forEach(entry => {
        addResult(`Message to ${entry.number}: ${entry.status}`, entry.status === 'sent');
      });
    } else {
      // Handle single result object or success message
      addResult(result.message || "Messages queued successfully", true);
    }
    showToast("Messages sent successfully!", 'success');
  } catch (error) {
    addResult(error.message, false);
    showToast(error.message, 'error');
  }
}

// Add this function to handle downloading results
function downloadResults() {
    const results = document.getElementById('results');
    const resultItems = results.getElementsByTagName('li');
    const message = document.getElementById("message").value;
    
    // Convert results to array of objects
    const data = Array.from(resultItems).map(item => {
        const text = item.innerText;
        const [timestamp, messageInfo] = text.split('] ');
        const phoneNumber = messageInfo.split(' ').pop(); // Get the phone number from the end

        return {
            'Timestamp': timestamp.replace('[', ''),
            'Phone Number': phoneNumber,
            'Status': item.className === 'success' ? 'Success' : 'Failed',
            'Message Template': message,
            'Full Message': messageInfo.trim()
        };
    });

    // Create worksheet
    const ws = XLSX.utils.json_to_sheet(data);
    
    // Set column widths
    ws['!cols'] = [
        { wch: 20 }, // Timestamp
        { wch: 15 }, // Phone Number
        { wch: 10 }, // Status
        { wch: 50 }, // Message Template
        { wch: 50 }  // Full Message
    ];
    
    // Create workbook
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Results");
    
    // Generate timestamp for filename
    const now = new Date();
    const filename = `whatsapp_results_${now.toISOString().split('T')[0]}.xlsx`;
    
    // Save file
    XLSX.writeFile(wb, filename);
}

// Add event listener for download button
document.getElementById('btn-download-results').addEventListener('click', downloadResults);

// Event listeners to insert placeholders into the message textarea
document.getElementById("btn-firstname").addEventListener("click", function () {
  const textarea = document.getElementById("message");
  textarea.value += " {firstName}";
});
document.getElementById("btn-lastname").addEventListener("click", function () {
  const textarea = document.getElementById("message");
  textarea.value += " {lastName}";
});

// Subscribe to SSE status updates and update the client status indicator
const statusSource = new EventSource("/status");
statusSource.onmessage = function (event) {
    const status = event.data;
    const statusText = document.getElementById("client-status");
    const mainContent = document.getElementById("main-content");
    const qrSection = document.getElementById("qr-section");
    const signoutBtn = document.getElementById("btn-signout");
    console.log('Status update received:', status);
    
    switch(status) {
        case "ready":
            statusText.innerText = "Client Status: Connected";
            statusText.className = "status-text neon-text";
            qrSection.classList.add("hidden");
            signoutBtn.classList.remove("hidden");
            mainContent.classList.remove("hidden");
            break;
            
        case "scan_qr":
            statusText.innerText = "Please scan the QR code with WhatsApp";
            statusText.className = "status-text";
            statusText.style.color = "#25d366"; // WhatsApp green color
            qrSection.classList.remove("hidden");
            signoutBtn.classList.add("hidden");
            mainContent.classList.add("hidden");
            fetchQRCode();
            break;
            
        default:
            statusText.innerText = "Client Status: " + status;
            statusText.className = "status-text";
            statusText.style.color = "#ff4444";
            qrSection.classList.remove("hidden");
            signoutBtn.classList.add("hidden");
            mainContent.classList.add("hidden");
    }
};

// Call fetchQRCode on page load
document.addEventListener('DOMContentLoaded', fetchQRCode);

// Sign-out button event listener
document.getElementById("btn-signout").addEventListener("click", async () => {
  const result = await Swal.fire({
    title: 'Are you sure?',
    text: "You won't be able to revert this!",
    icon: 'warning',
    showCancelButton: true,
    confirmButtonColor: '#3085d6',
    cancelButtonColor: '#d33',
    confirmButtonText: 'Yes, sign out!'
  });

  if (result.isConfirmed) {
    try {
      const response = await fetch("/signout", { method: "POST" });
      if (!response.ok) {
        const errData = await response.json();
        throw new Error(errData.error || "Sign out failed");
      }
      showToast("Signed out successfully.", 'success');
      document.getElementById("main-content").classList.add("hidden");
      document.getElementById("qr-section").classList.remove("hidden");
      document.getElementById("btn-signout").classList.add("hidden");
    } catch (error) {
      showToast("Error: " + error.message, 'error');
    }
  }
});

// Subscribe to SSE progress updates and update the progress bar
const evtSource = new EventSource("/progress");
evtSource.onmessage = function (event) {
  const progress = event.data;
  document.getElementById("progress-bar-fill").style.width = progress + "%";
  document.getElementById("progress-text").innerText = progress + "% complete";
};

// Subscribe to SSE message status updates
const messageStatusSource = new EventSource("/message-status");
messageStatusSource.onmessage = function(event) {
    try {
        // Validate that we have data
        if (!event.data) {
            throw new Error('Empty event data received');
        }

        console.log("Raw message status:", event.data); // Debug log

        // Parse JSON with error handling
        let status;
        try {
            status = JSON.parse(event.data);
        } catch (parseError) {
            throw new Error(`JSON parse error: ${parseError.message}\nRaw data: ${event.data}`);
        }

        // Validate required fields
        if (!status.number || !status.hasOwnProperty('success')) {
            throw new Error('Invalid status data format');
        }

        const timestamp = new Date(status.timestamp || Date.now());
        const phoneNumber = status.number.replace('@c.us', '');
        
        // Create detailed message with error info if available
        const message = status.success 
            ? `Message sent to ${phoneNumber}`
            : `Failed to send to ${phoneNumber}: ${status.error || 'Unknown error'}`;
        
        // Add result to the list
        addResult(message, status.success, timestamp);

    } catch (error) {
        console.error('Error processing message status:', error);
        console.error('Event data:', event.data);
        addResult(`Error processing status update: ${error.message}`, false);
    }
};

function updatePreview() {
    const textarea = document.getElementById("message");
    const preview = document.getElementById("message-preview");
    let text = textarea.value;
    
    // Convert WhatsApp markdown to HTML
    text = text
        .replace(/\*(.*?)\*/g, '<strong>$1</strong>') // Bold
        .replace(/_(.*?)_/g, '<em>$1</em>') // Italic
        .replace(/~(.*?)~/g, '<s>$1</s>') // Strikethrough
        .replace(/```(.*?)```/g, '<code class="multiline">$1</code>') // Code block
        .replace(/`(.*?)`/g, '<code>$1</code>') // Inline code
        .replace(/>>>(.*?)$/gm, '<blockquote>$1</blockquote>') // Quote
        .replace(/^• (.*?)$/gm, '<li>$1</li>') // Bullet points
        .replace(/^\d+\. (.*?)$/gm, '<li>$1</li>') // Numbered list
        .replace(/\n/g, '<br>'); // Line breaks
    
    preview.innerHTML = text || 'Preview will appear here...';
}

function formatText(type) {
    const textarea = document.getElementById("message");
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selectedText = textarea.value.substring(start, end);
    let prefix = "", suffix = "";

    switch (type) {
        case "bold": prefix = "*"; suffix = "*"; break;
        case "italic": prefix = "_"; suffix = "_"; break;
        case "strikethrough": prefix = "~"; suffix = "~"; break;
        case "monospace": prefix = "```"; suffix = "```"; break;
        case "quote": prefix = ">>>"; break;
        case "inline-code": prefix = "`"; suffix = "`"; break;
        case "bullet-list": prefix = "• "; break;
        case "numbered-list": 
            const lines = selectedText.split('\n');
            const numbered = lines.map((line, i) => `${i + 1}. ${line}`).join('\n');
            textarea.value = 
                textarea.value.substring(0, start) +
                numbered +
                textarea.value.substring(end);
            updatePreview();
            return;
    }

    const formattedText = prefix + selectedText + suffix;
    textarea.value = 
        textarea.value.substring(0, start) +
        formattedText +
        textarea.value.substring(end);
    
    textarea.selectionStart = start + prefix.length;
    textarea.selectionEnd = end + prefix.length;
    textarea.focus();
    
    updatePreview();
}

// Add input event listener for live preview
document.getElementById("message").addEventListener("input", updatePreview);
// Initial preview
updatePreview();

// Update format button event listeners
document.getElementById("btn-bold").addEventListener("click", () => formatText("bold"));
document.getElementById("btn-italic").addEventListener("click", () => formatText("italic"));
document.getElementById("btn-strikethrough").addEventListener("click", () => formatText("strikethrough"));
document.getElementById("btn-monospace").addEventListener("click", () => formatText("monospace"));
document.getElementById("btn-bullet-list").addEventListener("click", () => formatText("bullet-list"));
document.getElementById("btn-numbered-list").addEventListener("click", () => formatText("numbered-list"));
document.getElementById("btn-quote").addEventListener("click", () => formatText("quote"));
document.getElementById("btn-inline-code").addEventListener("click", () => formatText("inline-code"));

// Add function to generate example Excel file
function downloadExcelTemplate() {
    // Sample data
    const data = [
        ['WhatsApp Number(with country code)', 'First Name', 'Last Name'],
        ['+1234567890', 'John', 'Doe'],
        ['+9876543210', 'Jane', 'Smith']
    ];

    // Create a new workbook
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(data);

    // Set column widths
    ws['!cols'] = [
        { wch: 30 }, // WhatsApp Number
        { wch: 15 }, // First Name
        { wch: 15 }  // Last Name
    ];

    // Add the worksheet to the workbook
    XLSX.utils.book_append_sheet(wb, ws, "Template");

    // Generate and download the file
    XLSX.writeFile(wb, "whatsapp-contacts-template.xlsx");
}

// Add event listener for template download button
document.getElementById('btn-download-template').addEventListener('click', downloadExcelTemplate);

// Function to handle increment/decrement for a given input
function setupNumberInput(inputId) {
    const numberInput = document.getElementById(inputId);
    const container = numberInput.closest('.number-input-container');
    const incrementButton = container.querySelector('.arrow-button.increment');
    const decrementButton = container.querySelector('.arrow-button.decrement');

    // Increment value
    incrementButton.addEventListener('click', () => {
        numberInput.stepUp();
        toggleButtonState();
    });

    // Decrement value
    decrementButton.addEventListener('click', () => {
        numberInput.stepDown();
        toggleButtonState();
    });

    // Disable buttons when min/max is reached
    function toggleButtonState() {
        const max = parseFloat(numberInput.max) || Infinity; // Handle empty max attribute
        const min = parseFloat(numberInput.min) || 0; // Handle empty min attribute
        const value = parseFloat(numberInput.value);

        incrementButton.disabled = value >= max; // Disable increment if value >= max
        decrementButton.disabled = value <= min; // Disable decrement if value <= min
    }

    // Initial check
    toggleButtonState();

    // Update button state when input changes
    numberInput.addEventListener('input', toggleButtonState);
}

// Set up both inputs
setupNumberInput('min-interval');
setupNumberInput('max-interval');

// Update copyright year
document.getElementById('current-year').textContent = new Date().getFullYear();

// Update refresh button click handler
document.getElementById("btn-refresh").addEventListener("click", async () => {
    const refreshBtn = document.getElementById("btn-refresh");
    refreshBtn.disabled = true;
    
    try {
        await fetch("/refresh-qr", { 
            method: "POST",
            headers: { 'Cache-Control': 'no-cache' }
        });
        setTimeout(fetchQRCode, 2000); // Wait for 2 seconds before fetching new QR
        showToast("QR code refreshed.", 'success');
    } catch (error) {
        console.error('Error refreshing QR:', error);
        showToast('Error refreshing QR code', 'error');
        refreshBtn.disabled = false;
    }
});