import React, { useState, useEffect, useRef } from 'react';
import { format, subDays, addDays } from 'date-fns';
import { Activity, Clock, ChevronLeft, ChevronRight, ChevronDown, Monitor, Sparkles, Sunrise, CheckCircle, Circle, Trash2, Edit2, Save, MessageCircle, Send, Bell, BellOff, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import './index.css';

function App() {
  const [date, setDate] = useState(new Date());
  const [data, setData] = useState({ logs: [], summary: {} });
  const [aiSummary, setAiSummary] = useState('');
  const [morningTasks, setMorningTasks] = useState('');
  const [loadingAi, setLoadingAi] = useState(false);
  const [loadingMorning, setLoadingMorning] = useState(false);

  // Task States
  const [tasks, setTasks] = useState([]);
  const [newTask, setNewTask] = useState('');
  const [isEditingSummary, setIsEditingSummary] = useState(false);

  // Reminder States
  const [showReminderPicker, setShowReminderPicker] = useState(false);
  const [reminderTime, setReminderTime] = useState('');
  const [activePreset, setActivePreset] = useState('');
  const [activeTab, setActiveTab] = useState('summary'); // 'summary' or 'chat'

  // Chat States
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  const chatEndRef = useRef(null);

  useEffect(() => {
    fetchData(date);
    fetchSavedSummary(date);
    
    let interval;
    if (format(date, 'yyyy-MM-dd') === format(new Date(), 'yyyy-MM-dd')) {
      interval = setInterval(() => fetchData(date), 10000); 
    }
    return () => clearInterval(interval);
  }, [date]);

  useEffect(() => {
    fetchMorningTasks();
    fetchTasks();
  }, []);

  // Auto-scroll chat to bottom
  useEffect(() => {
    if (chatEndRef.current) {
      chatEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [chatMessages, chatLoading]);

  const fetchData = async (targetDate) => {
    try {
      const dateStr = format(targetDate, 'yyyy-MM-dd');
      const res = await fetch(`http://localhost:3001/api/summary/${dateStr}`);
      const result = await res.json();
      setData(result);
    } catch (err) {
      console.error('Failed to fetch data', err);
    }
  };

  const fetchTasks = async () => {
    try {
      const res = await fetch('http://localhost:3001/api/tasks');
      const result = await res.json();
      setTasks(result);
    } catch (err) {
      console.error('Failed to fetch tasks', err);
    }
  };

  const saveTasks = async (newTasks) => {
    setTasks(newTasks);
    try {
      await fetch('http://localhost:3001/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newTasks)
      });
    } catch (err) {
      console.error('Failed to save tasks', err);
    }
  };

  const setPresetTime = (preset) => {
    const now = new Date();
    let targetDate;
    if (preset === '1h') {
      targetDate = new Date(now.getTime() + 60 * 60 * 1000);
    } else if (preset === '2h') {
      targetDate = new Date(now.getTime() + 2 * 60 * 60 * 1000);
    } else if (preset === 'eod') {
      targetDate = new Date(now);
      targetDate.setHours(18, 0, 0, 0); // 6:00 PM
      if (targetDate <= now) {
        targetDate.setDate(targetDate.getDate() + 1);
      }
    }
    if (targetDate) {
      setReminderTime(format(targetDate, "yyyy-MM-dd'T'HH:mm"));
      setActivePreset(preset);
    }
  };

  const addTask = () => {
    if (!newTask.trim()) return;
    const task = { 
      id: Date.now(), 
      text: newTask, 
      completed: false 
    };
    if (reminderTime) {
      task.reminderAt = reminderTime;
    }
    const newTasks = [...tasks, task];
    saveTasks(newTasks);
    setNewTask('');
    setReminderTime('');
    setActivePreset('');
    setShowReminderPicker(false);
  };

  const toggleTask = (id) => {
    const newTasks = tasks.map(t => t.id === id ? { ...t, completed: !t.completed } : t);
    saveTasks(newTasks);
  };

  const deleteTask = (id) => {
    const newTasks = tasks.filter(t => t.id !== id);
    saveTasks(newTasks);
  };

  const clearReminder = async (id) => {
    try {
      await fetch(`http://localhost:3001/api/reminders/clear/${id}`, { method: 'POST' });
      const newTasks = tasks.map(t => {
        if (t.id === id) {
          const { reminderAt, ...rest } = t;
          return rest;
        }
        return t;
      });
      setTasks(newTasks);
    } catch (err) {
      console.error('Failed to clear reminder', err);
    }
  };

  const fetchSavedSummary = async (targetDate) => {
    setIsEditingSummary(false);
    try {
      const dateStr = format(targetDate, 'yyyy-MM-dd');
      const res = await fetch(`http://localhost:3001/api/saved-summary/${dateStr}`);
      const result = await res.json();
      setAiSummary(result.summary || '');
    } catch (err) {
      console.error('Failed to fetch saved summary', err);
    }
  };

  const saveSummary = async () => {
    try {
      const dateStr = format(date, 'yyyy-MM-dd');
      await fetch(`http://localhost:3001/api/saved-summary/${dateStr}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ summary: aiSummary })
      });
      setIsEditingSummary(false);
    } catch (err) {
      console.error('Failed to save summary', err);
    }
  };

  const fetchAiSummary = async () => {
    setLoadingAi(true);
    setAiSummary('');
    try {
      const dateStr = format(date, 'yyyy-MM-dd');
      const res = await fetch(`http://localhost:3001/api/analyze/${dateStr}`);
      const result = await res.json();
      if (result.error) {
        setAiSummary(`**Error:** ${result.error}`);
      } else {
        setAiSummary(result.analysis);
        await fetch(`http://localhost:3001/api/saved-summary/${dateStr}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ summary: result.analysis })
        });
      }
    } catch (err) {
      setAiSummary('Failed to connect to the local server for AI analysis.');
    }
    setLoadingAi(false);
  };

  const fetchMorningTasks = async (forceRefresh = false) => {
    setLoadingMorning(true);
    setMorningTasks('');
    try {
      const url = forceRefresh 
        ? `http://localhost:3001/api/morning-tasks?refresh=true`
        : `http://localhost:3001/api/morning-tasks`;
      const res = await fetch(url);
      const result = await res.json();
      if (result.error) {
        setMorningTasks(`**Error:** ${result.error}`);
      } else {
        setMorningTasks(result.analysis);
      }
    } catch (err) {
      setMorningTasks('Failed to connect to the local server for Morning Tasks.');
    }
    setLoadingMorning(false);
  };

  // Chat functions
  const sendChatMessage = async () => {
    if (!chatInput.trim() || chatLoading) return;
    
    const userMessage = { role: 'user', content: chatInput };
    setChatMessages(prev => [...prev, userMessage]);
    setChatInput('');
    setChatLoading(true);

    try {
      const dateStr = format(date, 'yyyy-MM-dd');
      const res = await fetch('http://localhost:3001/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: chatInput, date: dateStr })
      });
      const result = await res.json();
      
      if (result.error) {
        setChatMessages(prev => [...prev, { role: 'ai', content: `**Error:** ${result.error}` }]);
      } else {
        setChatMessages(prev => [...prev, { role: 'ai', content: result.response }]);
      }
    } catch (err) {
      setChatMessages(prev => [...prev, { role: 'ai', content: 'Failed to connect to the AI assistant.' }]);
    }
    setChatLoading(false);
  };

  const formatDuration = (seconds) => {
    if (seconds < 60) return `${Math.round(seconds)}s`;
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    return `${minutes}m`;
  };

  const formatReminderTime = (isoStr) => {
    try {
      return format(new Date(isoStr), 'MMM d, h:mm a');
    } catch {
      return isoStr;
    }
  };

  const maxDuration = Math.max(...Object.values(data.summary || { _: 1 }));

  return (
    <div className="dashboard">
      <header>
        <h1>Work Tracker</h1>
        <div className="date-selector">
          <button onClick={() => setDate(subDays(date, 1))}>
            <ChevronLeft size={20} />
          </button>
          <span>{format(date, 'MMMM d, yyyy')}</span>
          <button 
            onClick={() => setDate(addDays(date, 1))}
            disabled={format(date, 'yyyy-MM-dd') === format(new Date(), 'yyyy-MM-dd')}
            style={{ opacity: format(date, 'yyyy-MM-dd') === format(new Date(), 'yyyy-MM-dd') ? 0.3 : 1 }}
          >
            <ChevronRight size={20} />
          </button>
        </div>
      </header>

      {/* Manual Task List with Reminders */}
      <div className="card" style={{ marginBottom: '2rem', borderLeft: '4px solid #10b981' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
          <h2><CheckCircle size={24} color="#10b981" /> My Tasks</h2>
        </div>
        <div className="task-add-row">
          <input 
            type="text" 
            value={newTask}
            onChange={(e) => setNewTask(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addTask()}
            placeholder="Add a new task..." 
            style={{ flex: 1, padding: '0.75rem', borderRadius: '8px', border: '1px solid var(--border-color, var(--surface-border))', background: 'var(--card-bg, rgba(0,0,0,0.2))', color: 'var(--text-primary)' }}
          />
          <button 
            className={`reminder-btn ${showReminderPicker ? 'active' : ''}`}
            onClick={() => {
              if (showReminderPicker) {
                setReminderTime('');
                setActivePreset('');
              }
              setShowReminderPicker(!showReminderPicker);
            }}
            title="Set reminder"
          >
            <Bell size={18} />
          </button>
          <button onClick={addTask} style={{ background: '#10b981', color: '#fff', border: 'none', padding: '0 1.5rem', borderRadius: '8px', cursor: 'pointer', height: '42px', fontWeight: 600 }}>Add</button>
        </div>
        {showReminderPicker && (
          <div className="reminder-picker-card">
            <div className="reminder-presets">
              <span className="reminder-label">Suggestions:</span>
              <div className="preset-buttons">
                <button 
                  type="button" 
                  onClick={() => setPresetTime('1h')}
                  className={`preset-btn ${activePreset === '1h' ? 'active' : ''}`}
                >
                  1 Hour
                </button>
                <button 
                  type="button" 
                  onClick={() => setPresetTime('2h')}
                  className={`preset-btn ${activePreset === '2h' ? 'active' : ''}`}
                >
                  2 Hours
                </button>
                <button 
                  type="button" 
                  onClick={() => setPresetTime('eod')}
                  className={`preset-btn ${activePreset === 'eod' ? 'active' : ''}`}
                >
                  End of Day
                </button>
              </div>
            </div>
            
            <div className="reminder-custom">
              <div className="reminder-input-container">
                <Bell size={16} className="reminder-icon" />
                <span className="reminder-label">Custom Date & Time:</span>
                <input 
                  type="datetime-local" 
                  value={reminderTime}
                  onChange={(e) => {
                    setReminderTime(e.target.value);
                    setActivePreset('');
                  }}
                  min={format(new Date(), "yyyy-MM-dd'T'HH:mm")}
                />
              </div>
              {reminderTime && (
                <button 
                  onClick={() => { setReminderTime(''); setActivePreset(''); }}
                  className="reminder-clear-btn"
                  title="Clear reminder"
                >
                  <X size={16} />
                </button>
              )}
            </div>
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {tasks.length === 0 ? <p style={{color: 'var(--text-secondary)'}}>No tasks added yet.</p> : null}
          {tasks.map(task => (
            <div key={task.id} style={{ display: 'flex', alignItems: 'center', padding: '0.75rem', background: 'rgba(255,255,255,0.03)', borderRadius: '8px' }}>
              <button onClick={() => toggleTask(task.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', padding: '0', marginRight: '1rem' }}>
                {task.completed ? <CheckCircle color="#10b981" /> : <Circle color="var(--text-secondary)" />}
              </button>
              <span style={{ flex: 1, textDecoration: task.completed ? 'line-through' : 'none', color: task.completed ? 'var(--text-secondary)' : 'var(--text-primary)' }}>
                {task.text}
                {task.reminderAt && !task.reminderFired && (
                  <span className="reminder-badge">
                    <Bell size={12} />
                    {formatReminderTime(task.reminderAt)}
                    <button onClick={(e) => { e.stopPropagation(); clearReminder(task.id); }} title="Remove reminder">
                      <X size={12} />
                    </button>
                  </span>
                )}
                {task.reminderFired && (
                  <span className="reminder-badge" style={{ color: 'var(--text-secondary)', background: 'rgba(255,255,255,0.05)' }}>
                    <BellOff size={12} />
                    Reminded
                  </span>
                )}
              </span>
              <button onClick={() => deleteTask(task.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0', color: '#ef4444' }}>
                <Trash2 size={18} />
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Morning Tasks Banner */}
      <div className="card" style={{ marginBottom: '2rem', borderLeft: '4px solid #f59e0b' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
          <h2><Sunrise size={24} color="#f59e0b" /> Morning Action Plan</h2>
          <button 
            onClick={() => fetchMorningTasks(true)} 
            disabled={loadingMorning}
            style={{ background: '#f59e0b', color: '#fff', border: 'none', padding: '0.5rem 1rem', borderRadius: '8px', cursor: 'pointer' }}
          >
            {loadingMorning ? 'Analyzing...' : 'Refresh Suggestions'}
          </button>
        </div>
        <div className="markdown-body">
          {morningTasks ? <ReactMarkdown>{morningTasks}</ReactMarkdown> : <p style={{color: 'var(--text-secondary)'}}>Click refresh to analyze the past 7 days and get your morning tasks.</p>}
        </div>
      </div>

      {/* Redesigned Tab Section (Smart Summary & AI Assistant) */}
      <div className="tab-container" style={{ marginBottom: '2rem' }}>
        <div className="tab-bar">
          <button 
            type="button"
            className={`tab-btn ${activeTab === 'summary' ? 'active' : ''}`}
            onClick={() => setActiveTab('summary')}
          >
            <Sparkles size={16} />
            <span>Smart Summary</span>
          </button>
          <button 
            type="button"
            className={`tab-btn ${activeTab === 'chat' ? 'active' : ''}`}
            onClick={() => setActiveTab('chat')}
          >
            <MessageCircle size={16} />
            <span>AI Assistant</span>
          </button>
        </div>

        <div className="tab-content">
          {activeTab === 'summary' && (
            <div className="card" style={{ border: '1px solid rgba(99, 102, 241, 0.3)', background: 'linear-gradient(180deg, rgba(99,102,241,0.05) 0%, rgba(0,0,0,0) 100%)', margin: 0 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                <h2><Sparkles size={24} color="var(--accent-color)" /> Smart Summary</h2>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  {aiSummary && !isEditingSummary && (
                    <button onClick={() => setIsEditingSummary(true)} style={{ background: 'transparent', color: 'var(--accent-color)', border: '1px solid var(--accent-color)', padding: '0.5rem', borderRadius: '8px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                      <Edit2 size={16} /> Edit
                    </button>
                  )}
                  {isEditingSummary && (
                    <button onClick={saveSummary} style={{ background: '#10b981', color: '#fff', border: 'none', padding: '0.5rem', borderRadius: '8px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                      <Save size={16} /> Save
                    </button>
                  )}
                  <button 
                    onClick={fetchAiSummary} 
                    disabled={loadingAi || data.logs.length === 0}
                    style={{ background: 'var(--accent-color)', color: '#fff', border: 'none', padding: '0.5rem 1rem', borderRadius: '8px', cursor: data.logs.length === 0 ? 'not-allowed' : 'pointer', opacity: data.logs.length === 0 ? 0.5 : 1 }}
                  >
                    {loadingAi ? 'Generating...' : 'Generate'}
                  </button>
                </div>
              </div>
              
              <div className="markdown-body">
                {isEditingSummary ? (
                  <textarea
                    value={aiSummary}
                    onChange={(e) => setAiSummary(e.target.value)}
                    style={{ width: '100%', minHeight: '200px', padding: '1rem', background: 'rgba(0,0,0,0.2)', color: 'var(--text-primary)', border: '1px solid var(--border-color, var(--surface-border))', borderRadius: '8px', fontFamily: 'inherit', resize: 'vertical' }}
                  />
                ) : aiSummary ? (
                  <ReactMarkdown>{aiSummary}</ReactMarkdown>
                ) : (
                  <p style={{ color: 'var(--text-secondary)' }}>
                    Click generate to analyze today's raw logs into a human-readable summary.
                  </p>
                )}
              </div>
            </div>
          )}

          {activeTab === 'chat' && (
            <div className="card" style={{ borderLeft: '4px solid #8b5cf6', margin: 0 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                <h2><MessageCircle size={24} color="#8b5cf6" /> AI Assistant</h2>
              </div>
              
              <div className="chat-messages" style={{ marginTop: '1rem', maxHeight: '350px' }}>
                {chatMessages.length === 0 && (
                  <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-secondary)' }}>
                    <MessageCircle size={32} style={{ opacity: 0.3, marginBottom: '0.5rem' }} />
                    <p>Ask me anything about your work data!</p>
                    <p style={{ fontSize: '0.8rem', marginTop: '0.5rem', opacity: 0.7 }}>
                      e.g., "Summarize only my VS Code usage today" or "How productive was I this week?"
                    </p>
                  </div>
                )}
                {chatMessages.map((msg, i) => (
                  <div key={i} className={`chat-message ${msg.role}`}>
                    <div className="role">{msg.role === 'user' ? 'You' : 'AI Assistant'}</div>
                    <div className="content">
                      <ReactMarkdown>{msg.content}</ReactMarkdown>
                    </div>
                  </div>
                ))}
                {chatLoading && (
                  <div className="chat-message ai">
                    <div className="role">AI Assistant</div>
                    <div className="typing-indicator">
                      <span></span><span></span><span></span>
                    </div>
                  </div>
                )}
                <div ref={chatEndRef} />
              </div>

              <div className="chat-input-row">
                <input
                  className="chat-input"
                  type="text"
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && sendChatMessage()}
                  placeholder="Ask about your work data..."
                  disabled={chatLoading}
                />
                <button 
                  className="chat-send-btn"
                  onClick={sendChatMessage}
                  disabled={chatLoading || !chatInput.trim()}
                >
                  <Send size={16} />
                  Send
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="grid">
        <div className="card">
          <h2><Activity size={24} color="var(--accent-color)" /> Activity Timeline</h2>
          {data.logs && data.logs.length > 0 ? (
            <div className="timeline">
              {[...data.logs].reverse().map((log, index) => {
                const time = format(new Date(log.timestamp), 'HH:mm');
                return (
                  <div key={index} className="timeline-item" style={{ animationDelay: `${index * 0.05}s` }}>
                    <div className="timeline-time">{time}</div>
                    <div className="timeline-content">
                      <div className="timeline-app">{log.application}</div>
                      <div className="timeline-title">{log.title}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="empty-state">
              <Monitor size={48} className="empty-icon" />
              <p>No activity recorded for this day.</p>
            </div>
          )}
        </div>

        <div className="card">
          <h2><Clock size={24} color="#14b8a6" /> Raw Durations</h2>
          {Object.keys(data.summary || {}).length > 0 ? (
            <div className="summary-list">
              {Object.entries(data.summary).map(([app, duration], index) => {
                const percentage = (duration / maxDuration) * 100;
                return (
                  <div key={app} className="summary-item">
                    <div className="summary-header">
                      <span className="summary-app">{app}</span>
                      <span className="summary-duration">{formatDuration(duration)}</span>
                    </div>
                    <div className="progress-bar">
                      <div 
                        className="progress-fill" 
                        style={{ width: `${percentage}%`, backgroundColor: `var(--chart-colors)` }}
                      ></div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="empty-state">
              <p>No summary available.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default App;
