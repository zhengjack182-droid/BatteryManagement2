document.addEventListener('DOMContentLoaded', () => {

    // UI Elements
    const tabBtns = document.querySelectorAll('.tab-btn');
    const tabContents = document.querySelectorAll('.tab-content');
    const batteryGrid = document.getElementById('battery-grid');
    const maintenanceGrid = document.getElementById('maintenance-grid');
    const powerOptions = document.querySelectorAll('input[name="power_draw_mode"]');

    // State
    let dashboardData = {};
    let isDataLoaded = false;
    let isPowerOn = false;
    let customSelection = new Set();
    let overheatingBatteries = new Set();
    let aiModalShownForBatteries = new Set(); // track per-battery, not just once globally
    let maintainFetchInterval = null;
    let simulationInterval = null;

    // Simulation Config
    const DRAIN_RATE_TOTAL = 0.5; // percent per second total max
    const CHARGE_RATE = 0.2; // percent per second idly charging
    const TEMP_INCREASE_RATE = 0.5; // degrees per second under load
    const TEMP_COOL_RATE = 0.3; // degrees per second when resting
    const CRITICAL_TEMP = 37; // degrees when battery is excluded from pool + red glow triggers
    const ALERT_TEMP = 35;    // degrees when AI Analytics warning popup fires (early warning)
    const BASE_TEMP = 20;

    // Additional UI Elements
    const startSystemBtn = document.querySelector('.start-system-btn');
    const aiModal = document.getElementById('ai-modal');
    const aiModalApprove = document.getElementById('ai-modal-approve');
    const aiModalDismiss = document.getElementById('ai-modal-dismiss');
    const aiModalMessage = document.getElementById('ai-modal-message');

    // -----------------------------------------
    // Event Listeners
    // -----------------------------------------

    // Tab Switching
    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            // Remove active class
            tabBtns.forEach(b => b.classList.remove('active'));
            tabContents.forEach(c => c.classList.remove('active'));

            // Add active class
            btn.classList.add('active');
            document.getElementById(`${btn.dataset.tab}-tab`).classList.add('active');
        });
    });

    // Power Options
    powerOptions.forEach(opt => {
        opt.addEventListener('change', (e) => {
            updateSettings({ power_draw_mode: e.target.value });
            renderDashboard(); // Re-render to show/hide checkboxes if Custom
        });
    });

    // Toggle System Power
    if (startSystemBtn) {
        startSystemBtn.addEventListener('click', () => {
            isPowerOn = !isPowerOn;
            if (isPowerOn) {
                startSystemBtn.textContent = "Stop System Power";
                startSystemBtn.classList.add("power-on");
            } else {
                startSystemBtn.textContent = "Start System Power";
                startSystemBtn.classList.remove("power-on");
            }
            renderDashboard(); // update badges
        });
    }

    // AI Modal Actions
    if (aiModalApprove) {
        aiModalApprove.addEventListener('click', () => {
            // Auto-fix: switch to balanced mode to relieve overheating battery
            fetch('/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ power_draw_mode: 'balanced' })
            }).then(() => {
                dashboardData.settings.power_draw_mode = 'balanced';
                const radioMode = document.querySelector(`input[value="balanced"]`);
                if (radioMode) radioMode.checked = true;

                aiModal.classList.remove('active');
                showToast("System auto-switched to Load Balance mode");
                renderDashboard();
            });
        });
    }

    if (aiModalDismiss) {
        aiModalDismiss.addEventListener('click', () => {
            aiModal.classList.remove('active');
        });
    }

    // -----------------------------------------
    // API Functions
    // -----------------------------------------

    async function fetchData() {
        try {
            const response = await fetch('/api/data');
            const data = await response.json();

            // Only overwrite dashboard data entirely on first load to prevent resetting simulation
            if (!isDataLoaded) {
                dashboardData = data;
                Object.keys(dashboardData.batteries).forEach(batId => {
                    if (dashboardData.batteries[batId]["SoC"] === null) {
                        dashboardData.batteries[batId]["SoC"] = 0;
                    }
                    if (dashboardData.batteries[batId]["Temperature ΔT"] === null) {
                        dashboardData.batteries[batId]["Temperature ΔT"] = 0;
                    }
                });
                isDataLoaded = true;
                startFrontendSimulation();
                renderChartsFirstTime();
            } else {
                // Just update settings but don't overwrite fluctuating SoC/Temp
                dashboardData.settings = data.settings;
            }

            renderDashboard();
        } catch (error) {
            console.error("Error fetching data:", error);
            showToast("Failed to connect to backend", true);
        }
    }

    async function updateSettings(settingsData) {
        try {
            const response = await fetch('/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(settingsData)
            });
            const result = await response.json();

            if (!response.ok) {
                showToast(result.detail || "Error updating settings", true);
            } else {
                dashboardData.settings.power_draw_mode = settingsData.power_draw_mode;
                showToast("Settings updated successfully");
                renderDashboard();
            }
        } catch (error) {
            console.error("Error updating settings:", error);
            showToast("Failed to connect to backend", true);
        }
    }

    // -----------------------------------------
    // Rendering Functions
    // -----------------------------------------

    function getStatusClass(status) {
        status = status.toLowerCase();
        if (status.includes("healthy") || status.includes("normal")) return "status-healthy";
        if (status.includes("warning") || status.includes("soon") || status.includes("maintenance")) return "status-warning";
        if (status.includes("critical") || status.includes("risk")) return "status-critical";
        return "status-unknown";
    }

    function renderDashboard() {
        const { batteries, settings } = dashboardData;

        // Update Power Option selection statically
        const mode = settings.power_draw_mode || "balanced";
        const radioMode = document.querySelector(`input[value="${mode}"]`);
        if (radioMode) radioMode.checked = true;

        batteryGrid.innerHTML = '';
        maintenanceGrid.innerHTML = '';

        Object.keys(batteries).forEach(batId => {
            const batData = batteries[batId];
            const soc = batData["SoC"];
            const chargeLimit = settings.charge_limits?.[batId] || 100;

            // Format variables
            const healthPercentage = batData["SoH"].toFixed(1);

            // Base Temp (20) + Temp Change (ΔT)
            const tempVal = (20 + batData["Temperature ΔT"]).toFixed(0);

            // Conditional temp color (Yellow > 32)
            const tempColorClass = tempVal > 32 ? "color-warning" : "color-healthy";

            const voltageVal = batData["Average Voltage"].toFixed(2);
            const powerVal = batData["Average Power"].toFixed(0);

            const batteryClass = getStatusClass(batData["Overall Status"]).split('-')[1];
            const tankClass = soc < 30 ? "warning" : "healthy";

            const isOverheating = overheatingBatteries.has(batId);
            const isSelectedCustom = customSelection.has(batId);
            const isPowerModeCustom = mode === "custom";

            // Determine if battery is actively draining in this render frame
            let isActive = false;
            if (isPowerOn && !isOverheating && soc > 0) {
                if (mode === "balanced" || mode === "health-prioritized") {
                    isActive = true;
                } else if (mode === "custom" && isSelectedCustom) {
                    isActive = true;
                }
            }

            // -- Operational Status (simulation-driven, independent of SoH health) --
            let statusText, statusPillClass;
            if (isOverheating) {
                statusText = "Cooling Down";
                statusPillClass = "status-cooling";
            } else if (isActive) {
                statusText = "In Use";
                statusPillClass = "status-inuse";
            } else if (soc >= 99) {
                statusText = "Full";
                statusPillClass = "status-full";
            } else {
                statusText = "Charging";
                statusPillClass = "status-charging";
            }

            // Generate Battery Card Structure Matching the Mockup
            const batCard = document.createElement('div');
            batCard.className = `battery-card ${isActive ? 'is-active' : ''} ${isOverheating ? 'is-overheating' : ''}`;
            batCard.innerHTML = `
                <div class="card-header">
                    <h3 class="m-card-title">BAT-${batId.replace('B0', '')}</h3>
                    <div class="status-pill ${statusPillClass}">
                         <span class="dot"></span> ${statusText}
                    </div>
                </div>
                ${isActive || isOverheating ? `<div class="in-use-indicator ${isOverheating ? 'overheating' : ''}"><span class="dot"></span> ${isOverheating ? 'OVERHEATING' : 'IN USE'}</div>` : ''}
                
                <div class="battery-flex-container">
                    <!-- Left: Tank and SoC -->
                    <div class="battery-left-col">
                        <div class="battery-tank-wrapper">
                            <div class="battery-tip"></div>
                            <div class="battery-tank tank-${tankClass}">
                                <div class="battery-level-fill" style="height: ${soc}%"></div>
                            </div>
                        </div>
                        <div class="battery-percent-text color-${tankClass}">${soc.toFixed(0)}%</div>
                    </div>
                    
                    <!-- Right: Metrics Gray Box -->
                    <div class="battery-right-col gray-metrics-box">
                        <div class="metrics-grid-2x2">
                            <div class="metrics-cell">
                                <span class="m-label">HEALTH</span>
                                <span class="m-value color-${batteryClass}">${healthPercentage}%</span>
                            </div>
                            <div class="metrics-cell">
                                <span class="m-label">TEMP</span>
                                <span class="m-value ${tempColorClass}">${tempVal}°C</span>
                            </div>
                        </div>
                        
                        <div class="metrics-row-single mt-2">
                            <span class="m-label">AVERAGE VOLTAGE</span>
                            <span class="m-value-large color-${batteryClass}">${voltageVal} V</span>
                        </div>
                        
                        <div class="metrics-row-single mt-2">
                            <span class="m-label">POWER</span>
                            <span class="m-value-small">${powerVal} W</span>
                        </div>
                        
                        <div class="custom-select-wrapper ${isPowerModeCustom ? 'show' : ''}">
                            <label class="custom-checkbox">
                                <input type="checkbox" value="${batId}" ${isSelectedCustom ? 'checked' : ''} class="bat-custom-check"> Use Battery
                            </label>
                        </div>
                    </div>
                </div>
            `;

            // Bind checkbox
            const checkbox = batCard.querySelector('.bat-custom-check');
            if (checkbox) {
                checkbox.addEventListener('change', (e) => {
                    if (e.target.checked) {
                        customSelection.add(batId);
                    } else {
                        customSelection.delete(batId);
                    }
                });
            }

            batteryGrid.appendChild(batCard);

            // Generate Maintenance Card
            let maintRulDisplay;
            if (batData["RUL Days"] === null) {
                maintRulDisplay = "N/A";
            } else if (batData["RUL Days"] > 9000) {
                maintRulDisplay = "∞";
            } else if (batData["RUL Days"] < 0) {
                maintRulDisplay = "Replacement Needed";
            } else {
                maintRulDisplay = Math.round(batData["RUL Days"]) + " Days";
            }

            let predFailDay = batData["Predicted Failure Day"] === null ? "N/A" : (batData["Predicted Failure Day"] > 9000 ? "∞" : Math.round(batData["Predicted Failure Day"]));

            // -- Maintenance Suggestion Logic (per user spec) --
            const soh = batData["SoH"];
            const cycles = batData["Cycle Count"];
            let suggestion, suggestionClass;
            if (soh > 70 && cycles < 500) {
                suggestion = "Healthy";
                suggestionClass = "maint-healthy";
            } else if ((soh >= 60 && soh <= 70) || (cycles >= 500 && cycles <= 700)) {
                suggestion = "Maintenance Recommended";
                suggestionClass = "maint-warning";
            } else if ((soh >= 50 && soh < 60) || cycles > 700) {
                suggestion = "Replace Soon";
                suggestionClass = "maint-orange";
            } else {
                suggestion = "Replacement Needed";
                suggestionClass = "maint-critical";
            }

            const maintCard = document.createElement('div');
            maintCard.className = `maintenance-card ${suggestionClass}`;
            maintCard.innerHTML = `
                <div class="card-header">
                    <h3>Battery ${batId}</h3>
                    <span class="status-badge ${getStatusClass(batData["Internal Resistance"])}">SoH: ${batData["SoH"]}%</span>
                </div>
                <div class="maint-suggestion-row ${suggestionClass}-bg">
                    <span class="suggestion-icon">${suggestion === 'Healthy' ? '✅' : suggestion === 'Maintenance Recommended' ? '⚠️' : suggestion === 'Replace Soon' ? '🔶' : '🔴'}</span>
                    <strong>${suggestion}</strong>
                </div>
                <div class="m-metric" ${maintRulDisplay === "Replacement Needed" ? 'style="background-color:#ffe6e6;"' : ''}>
                    <h4>Remaining Usage Life</h4>
                    <p ${maintRulDisplay === "Replacement Needed" ? 'style="color:#dc3545; font-size: 1.1rem"' : ''}>${maintRulDisplay}</p>
                </div>
                <div class="m-metric">
                    <h4>Predicted Failure</h4>
                    <p>Day ${predFailDay}</p>
                </div>
                <div class="m-metric">
                    <h4>Cycles</h4>
                    <p>${batData["Cycle Count"]}</p>
                </div>
            `;
            maintenanceGrid.appendChild(maintCard);
        });
    }

    // -----------------------------------------
    // Utilities
    // -----------------------------------------
    function showToast(message, isError = false) {
        const toast = document.getElementById("toast");
        toast.innerText = message;
        toast.style.backgroundColor = isError ? "#dc3545" : "#28a745";
        toast.className = "toast show";
        setTimeout(() => { toast.className = toast.className.replace("show", ""); }, 3000);
    }

    // -----------------------------------------
    // Frontend Simulation Engine (Drain & Charge)
    // -----------------------------------------
    function startFrontendSimulation() {
        if (simulationInterval) clearInterval(simulationInterval);

        simulationInterval = setInterval(() => {
            const { batteries, settings } = dashboardData;
            const mode = settings.power_draw_mode || "balanced";

            let activePool = [];

            // 1. Determine which batteries are active and should be drained
            if (isPowerOn) {
                Object.keys(batteries).forEach(batId => {
                    if (batteries[batId]["SoC"] > 0 && !overheatingBatteries.has(batId)) {
                        if (mode === "balanced" || mode === "health-prioritized") {
                            activePool.push(batId);
                        } else if (mode === "custom" && customSelection.has(batId)) {
                            activePool.push(batId);
                        }
                    }
                });
            }

            // 2. Perform Drain & Charge Logic
            Object.keys(batteries).forEach(batId => {
                let bat = batteries[batId];
                let isDraining = activePool.includes(batId);

                if (isDraining) {
                    let drainAmount = DRAIN_RATE_TOTAL / activePool.length;

                    if (mode === "health-prioritized") {
                        // PROTECTIVE: lower SoH batteries drain slower, higher SoH take more load
                        const sohFactor = bat["SoH"] / 100; // 0.0–1.0
                        const avgSoH = activePool.reduce((acc, id) => acc + batteries[id]["SoH"], 0) / activePool.length;
                        if (bat["SoH"] > avgSoH) {
                            drainAmount *= (1 + (1 - sohFactor) * 0.5); // healthier → drains more
                        } else {
                            drainAmount *= sohFactor * 0.8; // weaker → protected
                        }
                    } else {
                        // REALISTIC (balanced & custom): lower health = faster drain
                        // SoH 100% → modifier 1.0x, SoH 50% → modifier ~1.5x
                        const degradationModifier = 1 + (1 - bat["SoH"] / 100) * 0.8;
                        drainAmount *= degradationModifier;
                    }

                    bat["SoC"] = Math.max(0, bat["SoC"] - drainAmount);

                    // Logarithmic temperature rise: rate slows as temp approaches critical threshold
                    // headroom shrinks → rate drops, making it progressively harder to overheat
                    const headroom = Math.max(0.05, CRITICAL_TEMP - (BASE_TEMP + bat["Temperature ΔT"]));
                    const maxHeadroom = CRITICAL_TEMP - BASE_TEMP;
                    const tempIncrease = TEMP_INCREASE_RATE * (headroom / maxHeadroom);
                    bat["Temperature ΔT"] += tempIncrease;

                    // Two-stage thermal protection:
                    // Stage 1 (35°C) — AI alert fires to warn the user
                    // Stage 2 (37°C) — battery is actually excluded from pool (critical overheating)
                    const currentTotalTemp = BASE_TEMP + bat["Temperature ΔT"];
                    if (currentTotalTemp > ALERT_TEMP) {
                        triggerAIAnalyticsModal(batId);
                    }
                    if (currentTotalTemp > CRITICAL_TEMP) {
                        overheatingBatteries.add(batId);
                    }

                } else {
                    // Charging & Cooling Mode (Idle)
                    bat["SoC"] = Math.min(100, bat["SoC"] + CHARGE_RATE);

                    if (bat["Temperature ΔT"] > 0) {
                        bat["Temperature ΔT"] = Math.max(0, bat["Temperature ΔT"] - TEMP_COOL_RATE);
                    } else {
                        overheatingBatteries.delete(batId); // cleared
                        aiModalShownForBatteries.delete(batId); // reset so modal can fire again if it overheats later
                    }
                }
            });

            renderDashboard(); // Re-render every second to show animation

        }, 1000);
    }

    function triggerAIAnalyticsModal(batId) {
        // Only show once per battery per overheating event; reset when battery cools
        if (!aiModalShownForBatteries.has(batId) && isPowerOn) {
            const batName = `BAT-${batId.replace('B0', '')}`;
            aiModalMessage.innerHTML = `<p><strong>Critical Warning:</strong> ${batName} is exceeding safe thermal limits (>${ALERT_TEMP}°C).</p>
                                        <p>Recommendation: Immediately switch to <strong>Load Balance mode</strong> to distribute power and allow the battery to cool down safely.</p>`;
            aiModal.classList.add('active');
            aiModalShownForBatteries.add(batId);
        }
    }

    // -----------------------------------------
    // Maintenance Charts
    // -----------------------------------------
    let maintenanceChart = null;
    function renderChartsFirstTime() {
        const { batteries } = dashboardData;
        const labels = Object.keys(batteries).map(b => `BAT-${b.replace('B0', '')}`);
        const sohData = Object.keys(batteries).map(b => batteries[b]["SoH"]);
        const cycleData = Object.keys(batteries).map(b => batteries[b]["Cycle Count"]);

        // Create canvas inside maintenance tab if it doesn't exist
        const maintGrid = document.getElementById('maintenance-grid');
        const chartWrapper = document.createElement('div');
        chartWrapper.className = 'charts-container w-100';
        chartWrapper.innerHTML = `
            <div class="chart-box">
                <h3>State of Health (SoH) Overview</h3>
                <canvas id="sohChart"></canvas>
            </div>
            <div class="chart-box">
                <h3>Total Cycles Overview</h3>
                <canvas id="cyclesChart"></canvas>
            </div>
        `;
        // Insert before the cards
        maintGrid.parentElement.insertBefore(chartWrapper, maintGrid);

        // Render Charts using Chart.js
        const ctxSoH = document.getElementById('sohChart').getContext('2d');
        const ctxCycles = document.getElementById('cyclesChart').getContext('2d');

        new Chart(ctxSoH, {
            type: 'bar',
            data: {
                labels: labels,
                datasets: [{
                    label: 'State of Health (%)',
                    data: sohData,
                    backgroundColor: 'rgba(16, 185, 129, 0.6)',
                    borderColor: '#10B981',
                    borderWidth: 1
                }]
            },
            options: { scales: { y: { beginAtZero: true, max: 100 } } }
        });

        new Chart(ctxCycles, {
            type: 'bar',
            data: {
                labels: labels,
                datasets: [{
                    label: 'Cycle Count',
                    data: cycleData,
                    backgroundColor: 'rgba(59, 130, 246, 0.6)',
                    borderColor: '#3b82f6',
                    borderWidth: 1
                }]
            },
            options: { scales: { y: { beginAtZero: true } } }
        });
    }

    // -----------------------------------------
    // Initialize
    // -----------------------------------------
    fetchData();

    // We poll settings less frequently now just to sync any external changes,
    // but we don't overwrite SoC/Temp as that's handled by our simulation loop
    maintainFetchInterval = setInterval(fetchData, 10000);
});
