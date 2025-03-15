console.log('hello js');

let qrFetchTimer = null;
let lastQRFetch = 0;
const QR_FETCH_COOLDOWN = 20000; // 20 seconds between fetches
const QR_AUTO_RETRY_STATUSES = ['initializing', 'loading'];
const MAX_AUTO_RETRIES = 3;
let autoRetryCount = 0;
let isQRFetchPending = false;

// Update constants at the top
const RECONNECT_DELAY = 5000;
const MAX_RETRIES = 3;
let retryCount = 0;

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
    if (!spinner) return; // Handle case where element doesn't exist
    spinner.style.display = show ? 'flex' : 'none';
}

// Fetch QR Code
async function fetchQRCode(force = false) {
    if (isQRFetchPending) {
        console.log('QR fetch already in progress...');
        return;
    }

    try {
        isQRFetchPending = true;
        
        const response = await fetch('/qrcode', {
            method: 'GET',
            headers: {
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache'
            },
            credentials: 'include'
        });

        if (response.status === 429) {
            const data = await response.json();
            showToast(`Rate limited. Please wait ${data.waitTime} seconds.`, 'warning');
            return;
        }
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const data = await response.json();
        
        if (data.qrCode) {
            const qrElement = document.getElementById("qr-code-image");
            qrElement.innerHTML = `
                <img src="${data.qrCode}" alt="QR Code" class="neon-border" style="max-width: 100%; height: auto;">
            `;
        }
    } catch (error) {
        console.error('Error fetching QR code:', error);
        const retryIn = Math.min(Math.pow(2, retryCount) * 1000, 30000);
        setTimeout(() => {
            retryCount++;
            if (retryCount <= MAX_RETRIES) {
                fetchQRCode(true);
            }
        }, retryIn);
    } finally {
        isQRFetchPending = false;
    }
}

// Separate UI update logic
function updateUI(data) {
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
            if (data.qrCode) {
                qrElement.innerHTML = `
                    <img src="${data.qrCode}" alt="QR Code" class="neon-border" style="max-width: 100%; height: auto;">
                `;
            }
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
            break;
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

// Add EventSource helper class
class ReconnectingEventSource {
    constructor(url, options = {}) {
        this.url = url;
        this.options = options;
        this.eventSource = null;
        this.reconnectAttempt = 0;
        this.maxReconnectAttempts = options.maxReconnectAttempts || 10;
        this.reconnectInterval = options.reconnectInterval || 3000;
        this.listeners = new Map();
        this.connect();
    }

    connect() {
        if (this.eventSource) {
            this.eventSource.close();
        }

        try {
            this.eventSource = new EventSource(this.url, {
                withCredentials: true
            });
            
            this.eventSource.onopen = () => {
                console.log('✅ EventSource connected:', this.url);
                this.reconnectAttempt = 0;
            };

            this.eventSource.onerror = (error) => {
                if (this.eventSource.readyState === EventSource.CLOSED) {
                    console.log('EventSource closed, attempting reconnect...');
                    this.handleDisconnect();
                }
            };

            // Reattach listeners
            this.listeners.forEach((listener, event) => {
                this.eventSource.addEventListener(event, listener);
            });
        } catch (error) {
            console.error('EventSource connection error:', error);
            this.handleDisconnect();
        }
    }

    handleDisconnect() {
        if (this.reconnectAttempt >= this.maxReconnectAttempts) {
            console.error('Max reconnection attempts reached');
            return;
        }

        this.reconnectAttempt++;
        const delay = this.reconnectInterval * Math.pow(2, this.reconnectAttempt - 1);
        console.log(`Reconnecting in ${delay/1000}s... (Attempt ${this.reconnectAttempt}/${this.maxReconnectAttempts})`);
        setTimeout(() => this.connect(), delay);
    }

    addEventListener(event, listener) {
        this.listeners.set(event, listener);
        this.eventSource?.addEventListener(event, listener);
    }

    close() {
        this.eventSource?.close();
        this.eventSource = null;
    }
}

// Update EventSource instances to use the new class
const statusSource = new ReconnectingEventSource("/status", {
    maxReconnectAttempts: 10,
    reconnectInterval: 5000
});

const progressSource = new ReconnectingEventSource("/progress", {
    maxReconnectAttempts: 10,
    reconnectInterval: 5000
});

const messageStatusSource = new ReconnectingEventSource("/message-status", {
    maxReconnectAttempts: 10,
    reconnectInterval: 5000
});

// Update event listeners to use addEventListener
statusSource.addEventListener('message', function(event) {
    const status = event.data;
    const statusText = document.getElementById("client-status");
    const mainContent = document.getElementById("main-content");
    const qrSection = document.getElementById("qr-section");
    const signoutBtn = document.getElementById("btn-signout");
    const qrElement = document.getElementById("qr-code-image");
    
    console.log('Status update received:', status);
    
    switch(status) {
        case "ready":
            statusText.innerText = "Connected to WhatsApp";
            statusText.className = "status-text neon-text";
            qrSection.classList.add("hidden");
            signoutBtn.classList.remove("hidden");
            mainContent.classList.remove("hidden");
            break;
            
        case "initializing":
        case "loading":
            statusText.innerText = "Initializing WhatsApp...";
            statusText.className = "status-text";
            qrSection.classList.remove("hidden");
            signoutBtn.classList.add("hidden");
            mainContent.classList.add("hidden");
            qrElement.innerHTML = `
                <div class="loading-qr">
                    <i class="fas fa-spinner fa-spin"></i>
                    <p>Initializing WhatsApp...</p>
                </div>
            `;
            break;
            
        case "scan_qr":
            statusText.innerText = "Please scan the QR code";
            statusText.className = "status-text";
            statusText.style.color = "#25d366";
            qrSection.classList.remove("hidden");
            signoutBtn.classList.add("hidden");
            mainContent.classList.add("hidden");
            fetchQRCode(true);
            break;
            
        default:
            statusText.innerText = `Status: ${status}`;
            statusText.className = "status-text";
            statusText.style.color = "#ff4444";
            qrSection.classList.remove("hidden");
            signoutBtn.classList.add("hidden");
            mainContent.classList.add("hidden");
    }
});

progressSource.addEventListener('message', function(event) {
    try {
        const progress = parseInt(event.data);
        const progressBar = document.getElementById("progress-bar-fill");
        const progressText = document.getElementById("progress-text");
        
        if (!isNaN(progress)) {
            progressBar.style.width = `${progress}%`;
            progressBar.style.transition = "width 0.5s ease-in-out";
            progressText.innerText = `${progress}% complete`;
            
            if (progress === 100) {
                progressBar.classList.add("completed");
            } else {
                progressBar.classList.remove("completed");
            }
        }
    } catch (error) {
        console.error('Progress update error:', error);
    }
});

messageStatusSource.addEventListener('message', function(event) {
    try {
        const status = JSON.parse(event.data);
        const timestamp = new Date(status.timestamp || Date.now());
        const phoneNumber = status.number.replace('@c.us', '');
        
        // Create status message with more details
        const statusMessage = status.success 
            ? `✅ Sent to ${phoneNumber}`
            : `❌ Failed: ${phoneNumber} - ${status.error || 'Unknown error'}`;
        
        // Add result with animation
        const resultsList = document.getElementById('results');
        const li = document.createElement('li');
        li.className = `message-status ${status.success ? 'success' : 'error'} fade-in`;
        
        // Format time with AM/PM
        const timeStr = timestamp.toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: true
        });
        
        li.innerHTML = `[${timeStr}] ${statusMessage}`;
        
        // Add to top of list with smooth animation
        resultsList.insertBefore(li, resultsList.firstChild);
        
        // Trigger fade-in animation
        requestAnimationFrame(() => {
            li.style.opacity = '1';
            li.style.transform = 'translateX(0)';
        });
        
        // Limit list items to most recent 100
        while (resultsList.children.length > 100) {
            resultsList.removeChild(resultsList.lastChild);
        }
        
        // Auto-scroll to latest
        li.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (error) {
        console.error('Message status update error:', error);
    }
});

// Clean up EventSource connections when page unloads
window.addEventListener('beforeunload', () => {
    statusSource.close();
    progressSource.close();
    messageStatusSource.close();
});

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
            showLoadingSpinner(true);
            const response = await fetch("/signout", { method: "POST" });
            if (!response.ok) {
                const errData = await response.json();
                throw new Error(errData.error || "Sign out failed");
            }
            
            // Clear current QR code
            const qrElement = document.getElementById("qr-code-image");
            qrElement.innerHTML = `
                <div class="loading-qr">
                    <i class="fas fa-spinner fa-spin"></i>
                    <p>Initializing WhatsApp...</p>
                </div>
            `;
            
            // Update UI state
            document.getElementById("main-content").classList.add("hidden");
            document.getElementById("qr-section").classList.remove("hidden");
            document.getElementById("btn-signout").classList.add("hidden");
            
            showToast("Signed out successfully.", 'success');
            
            // Fetch new QR code after a delay
            setTimeout(fetchQRCode, 3000);
        } catch (error) {
            showToast("Error: " + error.message, 'error');
        } finally {
            showLoadingSpinner(false);
        }
    }
});

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
        const response = await fetch("/refresh-qr", { 
            method: "POST",
            headers: {
                'Cache-Control': 'no-cache',
                'Content-Type': 'application/json'
            },
            credentials: 'include'
        });
        
        if (response.status === 429) {
            const data = await response.json();
            showToast(`Please wait ${data.waitTime} seconds before refreshing`, 'warning');
            setTimeout(() => refreshBtn.disabled = false, data.waitTime * 1000);
            return;
        }
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        showToast("QR code refresh initiated", 'info');
    } catch (error) {
        console.error('Error refreshing QR:', error);
        showToast('Error refreshing QR code', 'error');
        refreshBtn.disabled = false;
    }
});