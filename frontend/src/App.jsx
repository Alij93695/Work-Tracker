import React, { useState, useEffect, useRef } from 'react';
import { format, subDays, addDays } from 'date-fns';
import { Activity, Clock, ChevronLeft, ChevronRight, Monitor, Sparkles, Sunrise, CheckCircle, Circle, Trash2, Edit2, Save, MessageCircle, Send, Bell, BellOff, X, Mic, Square, FileText, RefreshCw, Volume2, Zap, Moon } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import './index.css';

const NAV_ITEMS = [
  { key: 'overview', label: 'Overview', icon: Activity },
  { key: 'tasks', label: 'Tasks', icon: CheckCircle },
  { key: 'meetings', label: 'Meetings', icon: Mic },
  { key: 'chat', label: 'AI Assistant', icon: MessageCircle },
];

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
  const [activeView, setActiveView] = useState('overview');

  // Chat States
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  const chatEndRef = useRef(null);

  // Meeting States
  const [meetingStatus, setMeetingStatus] = useState(null);
  const [meetingsList, setMeetingsList] = useState([]);
  const [selectedMeeting, setSelectedMeeting] = useState(null);
  const [meetingTitle, setMeetingTitle] = useState('');
  const [meetingBusy, setMeetingBusy] = useState(false);
  const [summarizing, setSummarizing] = useState(false);
  const [meetingError, setMeetingError] = useState('');
  const transcriptEndRef = useRef(null);

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
    fetchMeetings();
  }, []);

  // Poll meeting status — keeps the live transcript and recording pill fresh
  useEffect(() => {
    fetchMeetingStatus();
    const interval = setInterval(fetchMeetingStatus, 4000);
    return () => clearInterval(interval);
  }, []);

  // Auto-scroll the live transcript
  useEffect(() => {
    if (transcriptEndRef.current) {
      transcriptEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [meetingStatus?.meeting?.segments?.length]);

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
      targetDate.setHours(18, 0, 0, 0);
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

  // Meeting functions
  const fetchMeetingStatus = async () => {
    try {
      const res = await fetch('http://localhost:3001/api/meetings/current');
      const result = await res.json();
      setMeetingStatus(result);
    } catch (err) {
      // server not up yet — keep last known status
    }
  };

  const fetchMeetings = async () => {
    try {
      const res = await fetch('http://localhost:3001/api/meetings');
      setMeetingsList(await res.json());
    } catch (err) {
      console.error('Failed to fetch meetings', err);
    }
  };

  const startMeeting = async () => {
    setMeetingBusy(true);
    setMeetingError('');
    try {
      const res = await fetch('http://localhost:3001/api/meetings/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: meetingTitle })
      });
      const result = await res.json();
      if (result.error) setMeetingError(result.error);
      else {
        setMeetingTitle('');
        setSelectedMeeting(null);
        await fetchMeetingStatus();
      }
    } catch (err) {
      setMeetingError('Failed to reach the local server.');
    }
    setMeetingBusy(false);
  };

  const stopMeeting = async () => {
    setMeetingBusy(true);
    setMeetingError('');
    try {
      const res = await fetch('http://localhost:3001/api/meetings/stop', { method: 'POST' });
      const result = await res.json();
      if (result.error) setMeetingError(result.error);
      else {
        await fetchMeetingStatus();
        await fetchMeetings();
        if (result.meeting) openMeeting(result.meeting.id);
      }
    } catch (err) {
      setMeetingError('Failed to reach the local server.');
    }
    setMeetingBusy(false);
  };

  const openMeeting = async (id) => {
    try {
      const res = await fetch(`http://localhost:3001/api/meetings/${id}`);
      if (res.ok) setSelectedMeeting(await res.json());
    } catch (err) {
      console.error('Failed to load meeting', err);
    }
  };

  const summarizeMeeting = async (id) => {
    setSummarizing(true);
    setMeetingError('');
    try {
      const res = await fetch(`http://localhost:3001/api/meetings/${id}/summarize`, { method: 'POST' });
      const result = await res.json();
      if (result.error) setMeetingError(result.error);
      else await openMeeting(id);
      await fetchMeetings();
    } catch (err) {
      setMeetingError('Failed to generate summary.');
    }
    setSummarizing(false);
  };

  const actOnSuggestion = async (meetingId, suggestionId, action) => {
    try {
      const res = await fetch(`http://localhost:3001/api/meetings/${meetingId}/suggested/${suggestionId}/${action}`, { method: 'POST' });
      const result = await res.json();
      if (result.error) setMeetingError(result.error);
      await openMeeting(meetingId);
      if (action === 'approve') await fetchTasks();
    } catch (err) {
      setMeetingError('Failed to update suggestion.');
    }
  };

  const deleteMeeting = async (id) => {
    try {
      await fetch(`http://localhost:3001/api/meetings/${id}`, { method: 'DELETE' });
      if (selectedMeeting?.id === id) setSelectedMeeting(null);
      await fetchMeetings();
    } catch (err) {
      console.error('Failed to delete meeting', err);
    }
  };

  const formatMeetingTime = (isoStr) => {
    if (!isoStr) return '';
    try {
      return format(new Date(isoStr), 'MMM d, h:mm a');
    } catch {
      return isoStr;
    }
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

  const meetingActive = !!meetingStatus?.active;
  const liveSegments = meetingStatus?.meeting?.segments || [];

  // ---- derived stats for the overview ----
  const allEntries = Object.entries(data.summary || {});
  const appOnly = allEntries.filter(([k]) => !k.startsWith('('));
  const awaySeconds = allEntries.filter(([k]) => k.startsWith('(')).reduce((a, [, v]) => a + v, 0);
  const totalActive = appOnly.reduce((a, [, v]) => a + v, 0);
  const topApp = appOnly.length > 0 ? appOnly[0][0] : '—';
  const maxDuration = Math.max(1, ...allEntries.map(([, v]) => v));
  const todayStr = format(date, 'yyyy-MM-dd');
  const meetingsToday = meetingsList.filter(m => (m.startedAt || '').startsWith(todayStr)).length;
  const isToday = todayStr === format(new Date(), 'yyyy-MM-dd');

  const activeNav = NAV_ITEMS.find(n => n.key === activeView) || NAV_ITEMS[0];

  // ---- shared blocks ----
  const dateSelector = (
    <div className="date-selector">
      <button className="icon-btn" onClick={() => setDate(subDays(date, 1))} title="Previous day">
        <ChevronLeft size={17} />
      </button>
      <span>{format(date, 'EEE, MMM d')}</span>
      <button
        className="icon-btn"
        onClick={() => setDate(addDays(date, 1))}
        disabled={isToday}
        title="Next day"
      >
        <ChevronRight size={17} />
      </button>
    </div>
  );

  const smartSummaryCard = (
    <div className="card accent-card">
      <div className="card-head">
        <h2><Sparkles size={19} /> Smart Summary</h2>
        <div className="btn-row">
          {aiSummary && !isEditingSummary && (
            <button className="btn btn-ghost" onClick={() => setIsEditingSummary(true)}>
              <Edit2 size={14} /> Edit
            </button>
          )}
          {isEditingSummary && (
            <button className="btn btn-success" onClick={saveSummary}>
              <Save size={14} /> Save
            </button>
          )}
          <button
            className="btn btn-primary"
            onClick={fetchAiSummary}
            disabled={loadingAi || data.logs.length === 0}
          >
            {loadingAi ? 'Generating…' : 'Generate'}
          </button>
        </div>
      </div>
      <div className="markdown-body">
        {isEditingSummary ? (
          <textarea
            className="summary-editor"
            value={aiSummary}
            onChange={(e) => setAiSummary(e.target.value)}
          />
        ) : aiSummary ? (
          <ReactMarkdown>{aiSummary}</ReactMarkdown>
        ) : (
          <p className="hint">Generate a human-readable summary of this day's raw activity.</p>
        )}
      </div>
    </div>
  );

  return (
    <div className="app-shell">
      {/* ---------------- Sidebar ---------------- */}
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><Zap size={17} /></div>
          <span className="brand-name">Scribe</span>
        </div>

        <nav className="nav">
          {NAV_ITEMS.map(item => {
            const Icon = item.icon;
            return (
              <button
                key={item.key}
                className={`nav-item ${activeView === item.key ? 'active' : ''}`}
                onClick={() => { setActiveView(item.key); if (item.key === 'meetings') fetchMeetings(); }}
              >
                <Icon size={17} />
                <span>{item.label}</span>
                {item.key === 'meetings' && meetingActive && <span className="recording-dot" />}
              </button>
            );
          })}
        </nav>

        <div className="sidebar-footer">
          <div className={`status-chip ${meetingActive ? 'rec' : ''}`}>
            <span className={meetingActive ? 'recording-dot' : 'live-dot'} />
            {meetingActive ? 'Recording meeting' : 'Tracking active'}
          </div>
        </div>
      </aside>

      {/* ---------------- Main ---------------- */}
      <main className="main">
        <header className="topbar">
          <div className="topbar-title">
            <h1>{activeNav.label}</h1>
            <p className="subtitle">{format(date, 'MMMM d, yyyy')}</p>
          </div>
          <div className="topbar-right">
            {meetingActive && (
              <span className="recording-pill" title="Meeting capture is running">
                <span className="recording-dot" /> REC
              </span>
            )}
            {dateSelector}
          </div>
        </header>

        {/* ---------------- Overview ---------------- */}
        {activeView === 'overview' && (
          <>
            <div className="stat-row">
              <div className="stat-tile">
                <div className="stat-icon violet"><Clock size={16} /></div>
                <div className="stat-value">{totalActive > 0 ? formatDuration(totalActive) : '—'}</div>
                <div className="stat-label">Tracked {isToday ? 'today' : 'this day'}</div>
              </div>
              <div className="stat-tile">
                <div className="stat-icon teal"><Monitor size={16} /></div>
                <div className="stat-value stat-value-text" title={topApp}>{topApp}</div>
                <div className="stat-label">Top application</div>
              </div>
              <div className="stat-tile">
                <div className="stat-icon violet"><Activity size={16} /></div>
                <div className="stat-value">{data.logs.length}</div>
                <div className="stat-label">Window switches</div>
              </div>
              <div className="stat-tile">
                <div className="stat-icon muted"><Moon size={16} /></div>
                <div className="stat-value">{awaySeconds > 0 ? formatDuration(awaySeconds) : '—'}</div>
                <div className="stat-label">Away / idle</div>
              </div>
            </div>

            {smartSummaryCard}

            <div className="grid">
              <div className="card">
                <div className="card-head">
                  <h2><Activity size={19} /> Activity Timeline</h2>
                </div>
                {data.logs && data.logs.length > 0 ? (
                  <div className="timeline">
                    {[...data.logs].reverse().map((log, index) => {
                      const time = format(new Date(log.timestamp), 'HH:mm');
                      const away = (log.application || '').startsWith('(');
                      return (
                        <div key={index} className={`timeline-item ${away ? 'away' : ''}`}>
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
                    <Monitor size={40} className="empty-icon" />
                    <p>No activity recorded for this day.</p>
                  </div>
                )}
              </div>

              <div className="card">
                <div className="card-head">
                  <h2><Clock size={19} /> Time by Application</h2>
                </div>
                {allEntries.length > 0 ? (
                  <div className="summary-list">
                    {allEntries.map(([app, duration]) => {
                      const percentage = (duration / maxDuration) * 100;
                      const away = app.startsWith('(');
                      return (
                        <div key={app} className={`summary-item ${away ? 'away' : ''}`} title={`${app}: ${formatDuration(duration)}`}>
                          <div className="summary-header">
                            <span className="summary-app">{app}</span>
                            <span className="summary-duration">{formatDuration(duration)}</span>
                          </div>
                          <div className="progress-bar">
                            <div className="progress-fill" style={{ width: `${percentage}%` }}></div>
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
          </>
        )}

        {/* ---------------- Tasks ---------------- */}
        {activeView === 'tasks' && (
          <>
            <div className="card">
              <div className="card-head">
                <h2><CheckCircle size={19} /> My Tasks</h2>
              </div>
              <div className="task-add-row">
                <input
                  type="text"
                  className="text-input"
                  value={newTask}
                  onChange={(e) => setNewTask(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && addTask()}
                  placeholder="Add a new task…"
                />
                <button
                  className={`icon-btn reminder-btn ${showReminderPicker ? 'active' : ''}`}
                  onClick={() => {
                    if (showReminderPicker) {
                      setReminderTime('');
                      setActivePreset('');
                    }
                    setShowReminderPicker(!showReminderPicker);
                  }}
                  title="Set reminder"
                >
                  <Bell size={17} />
                </button>
                <button className="btn btn-success" onClick={addTask}>Add</button>
              </div>
              {showReminderPicker && (
                <div className="reminder-picker-card">
                  <div className="reminder-presets">
                    <span className="reminder-label">Suggestions:</span>
                    <div className="preset-buttons">
                      <button type="button" onClick={() => setPresetTime('1h')} className={`preset-btn ${activePreset === '1h' ? 'active' : ''}`}>1 Hour</button>
                      <button type="button" onClick={() => setPresetTime('2h')} className={`preset-btn ${activePreset === '2h' ? 'active' : ''}`}>2 Hours</button>
                      <button type="button" onClick={() => setPresetTime('eod')} className={`preset-btn ${activePreset === 'eod' ? 'active' : ''}`}>End of Day</button>
                    </div>
                  </div>
                  <div className="reminder-custom">
                    <div className="reminder-input-container">
                      <Bell size={15} className="reminder-icon" />
                      <span className="reminder-label">Custom:</span>
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
                      <button onClick={() => { setReminderTime(''); setActivePreset(''); }} className="reminder-clear-btn" title="Clear reminder">
                        <X size={15} />
                      </button>
                    )}
                  </div>
                </div>
              )}
              <div className="task-list">
                {tasks.length === 0 ? <p className="hint">No tasks added yet.</p> : null}
                {tasks.map(task => (
                  <div key={task.id} className="task-item">
                    <button className="check-btn" onClick={() => toggleTask(task.id)}>
                      {task.completed ? <CheckCircle size={19} className="check-done" /> : <Circle size={19} className="check-open" />}
                    </button>
                    <span className={`task-text ${task.completed ? 'done' : ''}`}>
                      {task.text}
                      {task.source === 'meeting' && <span className="tag tag-meeting"><Mic size={10} /> meeting</span>}
                      {task.reminderAt && !task.reminderFired && (
                        <span className="reminder-badge">
                          <Bell size={11} />
                          {formatReminderTime(task.reminderAt)}
                          <button onClick={(e) => { e.stopPropagation(); clearReminder(task.id); }} title="Remove reminder">
                            <X size={11} />
                          </button>
                        </span>
                      )}
                      {task.reminderFired && (
                        <span className="reminder-badge fired">
                          <BellOff size={11} /> Reminded
                        </span>
                      )}
                    </span>
                    <button className="icon-btn danger" onClick={() => deleteTask(task.id)} title="Delete task">
                      <Trash2 size={16} />
                    </button>
                  </div>
                ))}
              </div>
            </div>

            <div className="card">
              <div className="card-head">
                <h2><Sunrise size={19} /> Morning Action Plan</h2>
                <button className="btn btn-warning" onClick={() => fetchMorningTasks(true)} disabled={loadingMorning}>
                  {loadingMorning ? 'Analyzing…' : 'Refresh Suggestions'}
                </button>
              </div>
              <div className="markdown-body">
                {morningTasks ? <ReactMarkdown>{morningTasks}</ReactMarkdown> : <p className="hint">Click refresh to analyze the past 7 days and get your morning tasks.</p>}
              </div>
            </div>
          </>
        )}

        {/* ---------------- Meetings ---------------- */}
        {activeView === 'meetings' && (
          <div className="card">
            <div className="card-head">
              <h2><Mic size={19} /> Meetings</h2>
              {meetingActive ? (
                <button className="btn btn-danger" onClick={stopMeeting} disabled={meetingBusy}>
                  <Square size={14} /> {meetingBusy ? 'Stopping…' : 'Stop & Summarize'}
                </button>
              ) : (
                <div className="btn-row">
                  <input
                    type="text"
                    className="text-input meeting-title-input"
                    value={meetingTitle}
                    onChange={(e) => setMeetingTitle(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && startMeeting()}
                    placeholder="Meeting title (optional)"
                  />
                  <button className="btn btn-danger" onClick={startMeeting} disabled={meetingBusy}>
                    <Mic size={14} /> {meetingBusy ? 'Starting…' : 'Start Capture'}
                  </button>
                </div>
              )}
            </div>

            {meetingError && <p className="error-text">{meetingError}</p>}

            {meetingActive ? (
              <div>
                <div className="meeting-live-header">
                  <span className="recording-dot" />
                  <strong>{meetingStatus.meeting.title}</strong>
                  <span className="hint">started {formatMeetingTime(meetingStatus.meeting.startedAt)}</span>
                  {meetingStatus.capture && meetingStatus.capture.system && (
                    <span className="capture-badge"><Volume2 size={12} /> Listening to system audio</span>
                  )}
                  {meetingStatus.pendingChunks > 0 && (
                    <span className="hint small">transcribing {meetingStatus.pendingChunks} chunk(s)…</span>
                  )}
                </div>
                {meetingStatus.meeting.error && (
                  <p className="warn-text">Capture warning: {meetingStatus.meeting.error}</p>
                )}
                <div className="transcript-box">
                  {liveSegments.length === 0 ? (
                    <p className="hint pad">
                      Listening to your meeting's audio… The live transcript appears here about 20-40 seconds
                      after speech is detected. No bot joins the call, the microphone stays off, and the meeting
                      app can't see this — audio is captured locally from this PC.
                    </p>
                  ) : (
                    liveSegments.map((seg, i) => (
                      <div key={i} className="transcript-segment">
                        <div className="transcript-time">{seg.start?.split('T')[1] || ''}</div>
                        <div className="transcript-text">{seg.text}</div>
                      </div>
                    ))
                  )}
                  <div ref={transcriptEndRef} />
                </div>
              </div>
            ) : (
              <div>
                <p className="hint intro">
                  Capture live meeting context without inviting a bot to the call. Scribe listens to the
                  system audio of your Zoom/Teams/VooV meeting locally on this PC (microphone stays off),
                  streams a live transcript, and generates an AI summary with suggested tasks when you stop —
                  tasks are only added to your list after you approve them.
                </p>

                {selectedMeeting && (
                  <div className="meeting-detail">
                    <div className="card-head">
                      <h3>{selectedMeeting.title}</h3>
                      <div className="btn-row">
                        <button
                          className="btn btn-primary"
                          onClick={() => summarizeMeeting(selectedMeeting.id)}
                          disabled={summarizing || (selectedMeeting.segments || []).length === 0}
                        >
                          <RefreshCw size={13} /> {summarizing ? 'Summarizing…' : (selectedMeeting.summary ? 'Regenerate Summary' : 'Generate Summary')}
                        </button>
                        <button className="icon-btn" onClick={() => setSelectedMeeting(null)} title="Close">
                          <X size={14} />
                        </button>
                      </div>
                    </div>
                    <p className="hint small">
                      {formatMeetingTime(selectedMeeting.startedAt)}
                      {selectedMeeting.endedAt ? ` — ${formatMeetingTime(selectedMeeting.endedAt)}` : ''}
                      {' · '}{(selectedMeeting.segments || []).length} transcript segment(s)
                      {selectedMeeting.status === 'processing' ? ' · finishing transcription…' : ''}
                    </p>
                    {selectedMeeting.summary ? (
                      <div className="markdown-body">
                        <ReactMarkdown>{selectedMeeting.summary}</ReactMarkdown>
                      </div>
                    ) : (
                      <p className="hint">
                        {(selectedMeeting.segments || []).length === 0
                          ? 'No speech was captured in this meeting.'
                          : 'No summary yet — click Generate Summary.'}
                      </p>
                    )}
                    {(selectedMeeting.suggestedTasks || []).length > 0 && (
                      <div className="suggested-tasks">
                        <h4><CheckCircle size={15} /> Suggested Tasks <span className="hint small">— added to My Tasks only after you approve</span></h4>
                        {selectedMeeting.suggestedTasks.map(s => (
                          <div key={s.id} className={`suggestion-item ${s.status}`}>
                            <span className="suggestion-text">{s.text}</span>
                            {s.status === 'suggested' && (
                              <>
                                <button className="btn btn-success sm" onClick={() => actOnSuggestion(selectedMeeting.id, s.id, 'approve')}>Add to My Tasks</button>
                                <button className="btn btn-ghost sm" onClick={() => actOnSuggestion(selectedMeeting.id, s.id, 'dismiss')}>Dismiss</button>
                              </>
                            )}
                            {s.status === 'added' && <span className="tag tag-added">✓ Added</span>}
                            {s.status === 'dismissed' && <span className="tag">Dismissed</span>}
                          </div>
                        ))}
                      </div>
                    )}
                    {(selectedMeeting.segments || []).length > 0 && (
                      <details className="transcript-details">
                        <summary>Full transcript</summary>
                        <div className="transcript-box compact">
                          {selectedMeeting.segments.map((seg, i) => (
                            <div key={i} className="transcript-segment">
                              <div className="transcript-time">{seg.start?.split('T')[1] || ''}</div>
                              <div className="transcript-text">{seg.text}</div>
                            </div>
                          ))}
                        </div>
                      </details>
                    )}
                  </div>
                )}

                <h3 className="section-label"><FileText size={15} /> Past Meetings</h3>
                {meetingsList.length === 0 ? (
                  <p className="hint">No meetings captured yet. Click "Start Capture" before your next call.</p>
                ) : (
                  <div className="meeting-list">
                    {meetingsList.map(m => (
                      <div
                        key={m.id}
                        onClick={() => openMeeting(m.id)}
                        className={`meeting-row ${selectedMeeting?.id === m.id ? 'selected' : ''}`}
                      >
                        <Mic size={15} className="meeting-row-icon" />
                        <span className="meeting-row-main">
                          {m.title}
                          <span className="hint small">
                            {formatMeetingTime(m.startedAt)} · {m.segmentCount} segment(s)
                            {m.hasSummary ? ' · summarized' : ''}
                          </span>
                        </span>
                        <button
                          className="icon-btn danger"
                          onClick={(e) => { e.stopPropagation(); deleteMeeting(m.id); }}
                          title="Delete meeting"
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ---------------- AI Assistant ---------------- */}
        {activeView === 'chat' && (
          <div className="card chat-card">
            <div className="card-head">
              <h2><MessageCircle size={19} /> AI Assistant</h2>
            </div>
            <div className="chat-messages">
              {chatMessages.length === 0 && (
                <div className="empty-state">
                  <MessageCircle size={30} className="empty-icon" />
                  <p>Ask me anything about your work data!</p>
                  <p className="hint small">
                    e.g., "Summarize only my VS Code usage today" or "How productive was I this week?"
                  </p>
                </div>
              )}
              {chatMessages.map((msg, i) => (
                <div key={i} className={`chat-message ${msg.role}`}>
                  <div className="role">{msg.role === 'user' ? 'You' : 'Scribe AI'}</div>
                  <div className="content">
                    <ReactMarkdown>{msg.content}</ReactMarkdown>
                  </div>
                </div>
              ))}
              {chatLoading && (
                <div className="chat-message ai">
                  <div className="role">Scribe AI</div>
                  <div className="typing-indicator">
                    <span></span><span></span><span></span>
                  </div>
                </div>
              )}
              <div ref={chatEndRef} />
            </div>
            <div className="chat-input-row">
              <input
                className="text-input"
                type="text"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && sendChatMessage()}
                placeholder="Ask about your work data…"
                disabled={chatLoading}
              />
              <button className="btn btn-primary" onClick={sendChatMessage} disabled={chatLoading || !chatInput.trim()}>
                <Send size={14} /> Send
              </button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
