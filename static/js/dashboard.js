// Kristina Dashboard v1.1
class KristinaDashboard {
    constructor() {
        this.currentAgent = 'kristina';
        this.messages = [];
        this.stats = {
            webMessages: 0,
            activeUsers: 1,
            uptime: '00:00'
        };
        this.startTime = Date.now();
        
        this.init();
    }

    init() {
        this.bindEvents();
        this.startUptimeCounter();
        this.simulateInitialData();
        this.loadStatus();
    }

    bindEvents() {
        const input = document.getElementById('chatInput');
        const sendBtn = document.getElementById('sendBtn');
        
        sendBtn.addEventListener('click', () => this.sendMessage());
        input.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.sendMessage();
        });

        document.querySelectorAll('.agent-btn').forEach(btn => {
            btn.addEventListener('click', (e) => this.switchAgent(e.currentTarget));
        });

        document.getElementById('clearChat').addEventListener('click', () => this.clearChat());
    }

    async sendMessage() {
        const input = document.getElementById('chatInput');
        const text = input.value.trim();
        if (!text) return;

        this.addMessage(text, 'user');
        input.value = '';
        
        this.stats.webMessages++;
        this.updateStats();

        this.showTyping();

        try {
            // ✅ Правильный JSON запрос
            const response = await fetch('/api/chat', {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                body: JSON.stringify({
                    message: text,
                    agent: this.currentAgent
                })
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const data = await response.json();
            this.hideTyping();
            this.addMessage(data.response, 'kristina');

        } catch (error) {
            this.hideTyping();
            this.addMessage('Связь потеряна... но я всё ещё здесь. Попробуй ещё раз.', 'kristina');
            console.error('Chat error:', error);
        }
    }

    addMessage(text, sender) {
        const container = document.getElementById('chatMessages');
        const time = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
        
        const messageDiv = document.createElement('div');
        messageDiv.className = `message ${sender}`;
        messageDiv.innerHTML = `
            ${text}
            <div class="message-time">${time}</div>
        `;
        
        container.appendChild(messageDiv);
        container.scrollTop = container.scrollHeight;
    }

    showTyping() {
        const container = document.getElementById('chatMessages');
        const typingDiv = document.createElement('div');
        typingDiv.className = 'message kristina typing-indicator';
        typingDiv.id = 'typingIndicator';
        typingDiv.innerHTML = `
            <div class="loading">
                <div class="loading-dot"></div>
                <div class="loading-dot"></div>
                <div class="loading-dot"></div>
                <span>Кристина печатает...</span>
            </div>
        `;
        container.appendChild(typingDiv);
        container.scrollTop = container.scrollHeight;
    }

    hideTyping() {
        const indicator = document.getElementById('typingIndicator');
        if (indicator) indicator.remove();
    }

    switchAgent(btn) {
        document.querySelectorAll('.agent-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        
        this.currentAgent = btn.dataset.agent;
        
        const agentNames = {
            'kristina': 'Kristina',
            'advisor': 'Advisor',
            'creative': 'Creative'
        };
        
        document.getElementById('activeAgentName').textContent = agentNames[this.currentAgent];
        this.addMessage(`Переключена на режим: ${agentNames[this.currentAgent]}`, 'kristina');
    }

    clearChat() {
        document.getElementById('chatMessages').innerHTML = '';
        this.addMessage('История очищена. Начинаем с чистого листа... ✨', 'kristina');
    }

    updateStats() {
        document.getElementById('statMessages').textContent = this.stats.webMessages;
    }

    startUptimeCounter() {
        setInterval(() => {
            const diff = Math.floor((Date.now() - this.startTime) / 1000);
            const hours = Math.floor(diff / 3600).toString().padStart(2, '0');
            const minutes = Math.floor((diff % 3600) / 60).toString().padStart(2, '0');
            const seconds = (diff % 60).toString().padStart(2, '0');
            
            document.getElementById('statUptime').textContent = `${hours}:${minutes}:${seconds}`;
        }, 1000);
    }

    async loadStatus() {
        try {
            const response = await fetch('/api/status');
            const data = await response.json();
            
            if (data.mood) {
                this.updateMood(data.mood.emoji, data.mood.label, data.mood.energy);
            }
        } catch (e) {
            console.log('Status load failed');
        }
    }

    updateMood(emoji, label, energy) {
        document.getElementById('moodEmoji').textContent = emoji;
        document.getElementById('moodLabel').textContent = label;
        document.getElementById('energyFill').style.width = `${energy}%`;
    }

    simulateInitialData() {
        this.updateMood('🌅', 'Утреннее любопытство', 65);
        
        setTimeout(() => {
            this.addMessage('Привет! Я Кристина. Готова к диалогу — выбери агента или просто напиши что у тебя на душе.', 'kristina');
        }, 500);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    window.dashboard = new KristinaDashboard();
});

// ✅ Загрузка системных логов
async function loadSystemLogs() {
    try {
        const response = await fetch('/api/logs?lines=20');
        const data = await response.json();
        
        const container = document.getElementById('logsContainer');
        if (!container) return;
        
        container.innerHTML = '';
        
        data.logs.forEach(log => {
            const logDiv = document.createElement('div');
            logDiv.className = `log-entry ${log.level}`;
            logDiv.innerHTML = `
                <span class="log-time">[${log.time}]</span>
                <strong>${log.source}:</strong> ${log.message}
            `;
            container.appendChild(logDiv);
        });
        
        container.scrollTop = container.scrollHeight;
    } catch (e) {
        console.error('Failed to load logs:', e);
    }
}

// Загружаем логи каждые 5 секунд
setInterval(loadSystemLogs, 5000);
loadSystemLogs();
