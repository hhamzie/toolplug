// ToolPlug Application JavaScript
class ToolPlugApp {
    constructor() {
        this.currentStep = 1;
        this.formData = {
            email: '',
            categories: [],
            day: ''
        };
        
        // API configuration
        this.API_BASE = location.hostname.endsWith(".pages.dev") ? "https://toolplug.xyz" : "";
        
        // Category mapping
        this.PRETTY = {
            dev: "Dev Discoveries", 
            design: "Designers Drawer", 
            product: "Product Picks",
            ops: "Ops Oasis", 
            creators: "Creator's Corner", 
            wildcard: "Wildcard Wonders"
        };

        // NEW: polling state
        this._pollTimer = null;
        this._onVis = null;
        
        this.init();
    }

    init() {
        this.bindEvents();
        this.updateProgressIndicator();
        this.handleConfirmedRedirect();
        this.setupStorageListener();
    }

    bindEvents() {
        // Start button - goes to categories
        const startBtn = document.getElementById('start-btn');
        
        if (startBtn) {
            startBtn.addEventListener('click', (e) => {
                e.preventDefault();
                this.goToStep(2); // Go directly to categories
            });
        }

        // Category step
        document.querySelectorAll('.category-card').forEach(card => {
            card.addEventListener('click', (e) => {
                e.preventDefault();
                this.toggleCategory(card);
            });
        });
        
        const backToHeroBtn = document.getElementById('back-to-hero');
        const continueToDaysBtn = document.getElementById('continue-to-days');
        
        if (backToHeroBtn) {
            backToHeroBtn.addEventListener('click', (e) => {
                e.preventDefault();
                this.goToStep(1);
            });
        }
        
        if (continueToDaysBtn) {
            continueToDaysBtn.addEventListener('click', (e) => {
                e.preventDefault();
                this.handleCategoryStep();
            });
        }

        // Day step
        document.querySelectorAll('.day-card').forEach(card => {
            card.addEventListener('click', (e) => {
                e.preventDefault();
                this.selectDay(card);
            });
        });
        
        const backToCategoriesBtn = document.getElementById('back-to-categories');
        const continueToEmailBtn = document.getElementById('continue-to-email');
        
        if (backToCategoriesBtn) {
            backToCategoriesBtn.addEventListener('click', (e) => {
                e.preventDefault();
                this.goToStep(2);
            });
        }
        
        if (continueToEmailBtn) {
            continueToEmailBtn.addEventListener('click', (e) => {
                e.preventDefault();
                this.handleDayStep();
            });
        }

        // Email step back button
        const backToDaysBtn = document.getElementById('back-to-days');
        if (backToDaysBtn) {
            backToDaysBtn.addEventListener('click', (e) => {
                e.preventDefault();
                this.goToStep(3);
            });
        }

        // Email confirmation back button
        const backToEmailInputBtn = document.getElementById('back-to-email-input');
        if (backToEmailInputBtn) {
            backToEmailInputBtn.addEventListener('click', (e) => {
                e.preventDefault();
                this.goToStep(4);
            });
        }

        // Subscribe button with API integration
        const subscribeBtn = document.getElementById('subscribe-btn');
        if (subscribeBtn) {
            subscribeBtn.addEventListener('click', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (e.stopImmediatePropagation) e.stopImmediatePropagation();
                
                await this.handleSubscribe();
            }, true);
        }

        // Resend email button
        const resendBtn = document.getElementById('resend-email');
        if (resendBtn) {
            resendBtn.addEventListener('click', async (e) => {
                e.preventDefault();
                await this.handleResendEmail();
            });
        }

        // Email input enter key
        const emailInput = document.getElementById('email');
        if (emailInput) {
            emailInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    this.handleSubscribe();
                }
            });
            
            emailInput.addEventListener('focus', () => {
                emailInput.style.outline = 'none';
            });
        }

        // Confirmation step
        const startOverBtn = document.getElementById('start-over');
        if (startOverBtn) {
            startOverBtn.addEventListener('click', (e) => {
                e.preventDefault();
                this.startOver();
            });
        }

        const exampleEmailBtn = document.getElementById('get-example-email');
        if (exampleEmailBtn) {
            exampleEmailBtn.addEventListener('click', (e) => {
                e.preventDefault();
                this.sendExampleEmail();
            });
        }
    }

    async handleSubscribe() {
        const categories = Array.from(
            document.querySelectorAll("#categories input[type=checkbox]:checked")
        ).map(cb => cb.value);

        const dayRadio = document.querySelector('#day-selection input[name="day"]:checked');
        const dayMap = { sunday:0, monday:1, tuesday:2, wednesday:3, thursday:4, friday:5, saturday:6 };
        const send_day = dayRadio ? dayMap[dayRadio.value] : null;

        const email = (document.getElementById("email")?.value || "").trim();

        if (!email || !categories.length || send_day == null) {
            alert("Please fill all fields (email, categories, day).");
            return;
        }

        // NEW: keep formData + localStorage in sync so the Congrats button knows the email
        this.formData.email = email;
        try { localStorage.setItem("tp_email", email); } catch {}

        const payload = { email, send_day, categories };
        localStorage.setItem("tp_sub", JSON.stringify(payload));

        try {
            const res = await fetch(this.API_BASE + "/api/subscribe", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(payload),
            });

            if (!res.ok) {
                const txt = await res.text();
                alert("Error: " + txt);
                return;
            }

            document.getElementById("confirmation-email-display").textContent = email;

            // NEW: start polling for cross-device confirmation
            this.startConfirmPolling(email);

            this.goToStep(5); // Go to email confirmation
        } catch {
            alert("Network error. Please try again.");
        }
    }

    async handleResendEmail() {
        const saved = JSON.parse(localStorage.getItem("tp_sub") || "{}");
        if (!saved.email) { 
            alert("Please submit the form first."); 
            return; 
        }
        
        try {
            const r = await fetch(this.API_BASE + "/api/subscribe", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(saved),
            });
            alert(r.ok ? "Confirmation email resent ✅" : "Resend failed: " + (await r.text()));
        } catch {
            alert("Network error. Please try again.");
        }
    }

    handleConfirmedRedirect() {
        const qs = new URLSearchParams(location.search);
        if (qs.get("confirmed") === "1") {
            this.fillConfirmationSummary();
            this.goToStep(6); // Go to final confirmation
            // NEW: stop any polling if it was running
            this.stopConfirmPolling();
            history.replaceState({}, "", location.pathname);
            return;
        }
        // NEW: if storage flag already exists (e.g., storage event missed), handle it
        this.checkConfirmFlag();
    }

    setupStorageListener() {
        window.addEventListener("storage", (ev) => {
            if (ev.key === "tp_confirmed" && ev.newValue === "1") {
                this.fillConfirmationSummary();
                this.goToStep(6); // Go to final confirmation
                // NEW: stop polling when we confirm via storage
                this.stopConfirmPolling();
                localStorage.removeItem("tp_confirmed");
            }
        });

        // NEW: also check when the tab regains focus / visibility (covers missed events)
        window.addEventListener("visibilitychange", () => {
            if (!document.hidden) this.checkConfirmFlag();
        });
        window.addEventListener("focus", () => this.checkConfirmFlag());
    }

    // NEW: helper used by the two places above
    checkConfirmFlag() {
        if (localStorage.getItem("tp_confirmed") === "1") {
            this.fillConfirmationSummary();
            this.goToStep(6);
            this.stopConfirmPolling(); // stop if running
            localStorage.removeItem("tp_confirmed");
        }
    }

    fillConfirmationSummary() {
        const saved = JSON.parse(localStorage.getItem("tp_sub") || "{}");
        
        if (saved.email) {
            document.getElementById("summary-email")?.replaceChildren(document.createTextNode(saved.email));
        }
        
        if (Array.isArray(saved.categories)) {
            document.getElementById("summary-categories")?.replaceChildren(
                document.createTextNode(saved.categories.map(c => this.PRETTY[c] || c).join(", "))
            );
        }
        
        if (typeof saved.send_day === "number") {
            const dayName = this.getDayName(saved.send_day);
            document.getElementById("summary-day")?.replaceChildren(document.createTextNode(dayName));
        }
    }

    getDayName(n) {
        return ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"][n] ?? "";
    }

    toggleCategory(card) {
        if (!card) return;
        
        const categoryId = card.dataset.category;
        const checkbox = card.querySelector('input[type="checkbox"]');
        
        if (!categoryId) {
            console.error('Category ID not found');
            return;
        }
        
        // Toggle selection
        if (card.classList.contains('selected')) {
            card.classList.remove('selected');
            if (checkbox) checkbox.checked = false;
            this.formData.categories = this.formData.categories.filter(cat => cat !== categoryId);
        } else {
            card.classList.add('selected');
            if (checkbox) checkbox.checked = true;
            if (!this.formData.categories.includes(categoryId)) {
                this.formData.categories.push(categoryId);
            }
        }

        console.log('Selected categories:', this.formData.categories);

        // Clear error if categories are selected
        if (this.formData.categories.length > 0) {
            const errorDiv = document.getElementById('categories-error');
            if (errorDiv) {
                errorDiv.textContent = '';
                errorDiv.style.display = 'none';
            }
        }
    }

    handleCategoryStep() {
        const errorDiv = document.getElementById('categories-error');
        
        if (errorDiv) {
            errorDiv.textContent = '';
            errorDiv.style.display = 'none';
        }

        // Validate at least one category is selected
        if (this.formData.categories.length === 0) {
            this.showError('categories-error', 'Please select at least one category');
            return;
        }

        console.log('Categories validated, proceeding to step 3');
        this.goToStep(3);
    }

    handleDayStep() {
        const errorDiv = document.getElementById('day-error');
        
        if (errorDiv) {
            errorDiv.textContent = '';
            errorDiv.style.display = 'none';
        }

        // Validate day selection
        if (!this.formData.day) {
            this.showError('day-error', 'Please select your preferred delivery day');
            return;
        }

        // Proceed to email step
        console.log('Day validated, proceeding to step 4');
        this.goToStep(4);
    }

    selectDay(card) {
        if (!card) return;
        
        const dayValue = card.dataset.day;
        const radio = card.querySelector('input[type="radio"]');

        // Remove selection from all day cards
        document.querySelectorAll('.day-card').forEach(c => c.classList.remove('selected'));
        document.querySelectorAll('input[name="day"]').forEach(r => r.checked = false);

        // Select the clicked day
        card.classList.add('selected');
        if (radio) radio.checked = true;
        this.formData.day = dayValue;

        console.log('Selected day:', this.formData.day);

        // Clear error
        const errorDiv = document.getElementById('day-error');
        if (errorDiv) {
            errorDiv.textContent = '';
            errorDiv.style.display = 'none';
        }
    }

    displayConfirmation() {
        // Update email
        const summaryEmail = document.getElementById('summary-email');
        if (summaryEmail) {
            summaryEmail.textContent = this.formData.email;
        }

        // Update categories
        const summaryCategories = document.getElementById('summary-categories');
        if (summaryCategories) {
            const categoryNames = this.formData.categories.map(catId => {
                return this.PRETTY[catId];
            });
            summaryCategories.textContent = categoryNames.join(', ');
        }

        // Update day
        const summaryDay = document.getElementById('summary-day');
        if (summaryDay) {
            const dayName = this.formData.day.charAt(0).toUpperCase() + this.formData.day.slice(1);
            summaryDay.textContent = dayName;
        }
    }

    goToStep(stepNumber) {
        console.log('Going to step:', stepNumber);
        
        // Hide all steps
        document.querySelectorAll('.step').forEach(step => {
            step.classList.remove('active');
        });

        // Show target step
        const targetSteps = ['hero', 'categories', 'day-selection', 'email-input', 'email-confirmation', 'confirmation'];
        const targetStep = document.getElementById(targetSteps[stepNumber - 1]);
        
        if (targetStep) {
            targetStep.classList.add('active');
        } else {
            console.error('Target step not found:', targetSteps[stepNumber - 1]);
        }

        // Update current step
        this.currentStep = stepNumber;
        this.updateProgressIndicator();
    }

    updateProgressIndicator() {
        // Update progress bar
        const progressFill = document.getElementById('progress-fill');
        if (progressFill) {
            const progressPercentage = (this.currentStep / 6) * 100;
            progressFill.style.width = `${progressPercentage}%`;
        }

        // Update progress steps
        document.querySelectorAll('.progress-step').forEach((step, index) => {
            const stepNumber = index + 1;
            step.classList.remove('active', 'completed');
            
            if (stepNumber === this.currentStep) {
                step.classList.add('active');
            } else if (stepNumber < this.currentStep) {
                step.classList.add('completed');
            }
        });
    }

    startOver() {
        console.log('Starting over');
        
        // Reset form data
        this.formData = {
            email: '',
            categories: [],
            day: ''
        };

        // Reset form inputs
        const emailInput = document.getElementById('email');
        if (emailInput) emailInput.value = '';
        
        document.querySelectorAll('.category-card').forEach(card => {
            card.classList.remove('selected');
            const checkbox = card.querySelector('input');
            if (checkbox) checkbox.checked = false;
        });
        
        document.querySelectorAll('.day-card').forEach(card => {
            card.classList.remove('selected');
            const radio = card.querySelector('input');
            if (radio) radio.checked = false;
        });

        // Clear all error messages
        document.querySelectorAll('.error-message').forEach(error => {
            error.textContent = '';
            error.style.display = 'none';
        });

        // Reset example email button
        const exampleEmailBtn = document.getElementById('get-example-email');
        if (exampleEmailBtn) {
            exampleEmailBtn.disabled = false;
            exampleEmailBtn.textContent = '📧 Daily MVP';
        }

        // Go back to first step
        this.goToStep(1);
    }

    // NEW: resolve the best email to send the MVP to
    resolveExampleEmail() {
        const summary = (document.getElementById("summary-email")?.textContent || "").trim();
        if (summary) return summary;

        try {
            const saved = JSON.parse(localStorage.getItem("tp_sub") || "{}");
            if (saved?.email) return saved.email;
        } catch {}

        const ls = (typeof localStorage !== "undefined" && localStorage.getItem("tp_email")) || "";
        if (ls) return ls;

        const input = /** @type {HTMLInputElement|null} */ (document.getElementById("email"));
        return (input?.value || this.formData.email || "").trim();
    }

    async sendExampleEmail() {
        try {
            const button = document.getElementById('get-example-email');
            if (button) {
                button.disabled = true;
                button.textContent = '📧 Sending...';
            }

            const email = this.resolveExampleEmail();
            if (!this.isValidEmail(email)) {
                alert("Need a valid email to send the Daily MVP.");
                return;
            }

            const response = await fetch(this.API_BASE + '/api/preview-daily', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email })
            });

            const data = await response.json().catch(() => ({}));

            if (response.ok && data?.ok) {
                if (button) {
                    button.textContent = '✅ Sent!';
                    // Don't auto-reset - only reset when they leave the page
                }
            } else {
                console.error('preview-daily error:', data);
                if (button) button.textContent = '❌ Try again';
                alert('Could not send the Daily MVP. Please try again.');
            }
        } catch (error) {
            console.error('Error sending example email:', error);
            const button = document.getElementById('get-example-email');
            if (button) {
                button.textContent = '❌ Try again';
            }
            alert('Network error sending Daily MVP.');
        } finally {
            const button = document.getElementById('get-example-email');
            if (button) {
                button.disabled = false;
            }
        }
    }

    isValidEmail(email) {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        return emailRegex.test(email);
    }

    showError(elementId, message) {
        const errorElement = document.getElementById(elementId);
        if (errorElement) {
            errorElement.textContent = message;
            errorElement.style.display = 'block';
            
            // Add a subtle shake animation to draw attention
            const parentElement = errorElement.previousElementSibling || errorElement.parentElement;
            if (parentElement) {
                parentElement.style.animation = 'none';
                setTimeout(() => {
                    parentElement.style.animation = 'shake 0.5s ease-in-out';
                }, 10);
            }
        }
    }

    // NEW: polling to support cross-device confirmation
    startConfirmPolling(email) {
        this.stopConfirmPolling();
        const query = encodeURIComponent((email || "").toLowerCase().trim());
        if (!query) return;

        const tick = async () => {
    try {
        const r = await fetch(this.API_BASE + "/api/status?email=" + query, { method: "GET" });
        if (r.ok) {
            const data = await r.json();
            if (data && data.subscribed) { // server now drives state!
                try { localStorage.setItem("tp_confirmed", "1"); } catch {}
                this.fillConfirmationSummary();
                this.goToStep(6);
                this.stopConfirmPolling();
            }
        }
    } catch {}
};


        // immediate check, then poll
        tick();
        this._pollTimer = setInterval(tick, 4000);

        // also re-check when the tab becomes visible again
        this._onVis = () => { if (!document.hidden) tick(); };
        document.addEventListener("visibilitychange", this._onVis);
    }

    // NEW: stop polling helper
    stopConfirmPolling() {
        if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
        if (this._onVis) { document.removeEventListener("visibilitychange", this._onVis); this._onVis = null; }
    }
}

// Initialize the application when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    console.log('DOM loaded, initializing ToolPlug app');
    new ToolPlugApp();
    
    // Add button ripple effects
    document.querySelectorAll('.btn').forEach(button => {
        // CHANGED (minimal): use pointerdown so ripple doesn't interfere with click handlers
        button.addEventListener('pointerdown', function(e) {
            const ripple = document.createElement('span');
            const rect = this.getBoundingClientRect();
            const size = Math.max(rect.width, rect.height);
            const x = e.clientX - rect.left - size / 2;
            const y = e.clientY - rect.top - size / 2;
            
            ripple.style.cssText = `
                position: absolute;
                border-radius: 50%;
                background: rgba(255, 255, 255, 0.3);
                transform: scale(0);
                animation: ripple 0.6s linear;
                width: ${size}px;
                height: ${size}px;
                left: ${x}px;
                top: ${y}px;
                pointer-events: none;
            `;
            
            this.appendChild(ripple);
            
            setTimeout(() => {
                ripple.remove();
            }, 600);
        }, { passive: true });
    });

    // Add ripple animation CSS
    const rippleStyle = document.createElement('style');
    rippleStyle.textContent = `
        @keyframes ripple {
            to {
                transform: scale(4);
                opacity: 0;
            }
        }
        
        .btn {
            overflow: hidden;
            position: relative;
        }
    `;
    document.head.appendChild(rippleStyle);
});
