const recordButton = document.getElementById("record");
const stopButton = document.getElementById("stop");
const transcribeButton = document.getElementById("transcribe");
const transcript = document.getElementById("transcript");
const summaryOutput = document.getElementById("summary");
const minutesOutput = document.getElementById("minutes-output");
const transcriptPreview = document.getElementById("transcript-preview");
const summaryMarkdown = document.getElementById("summary-markdown");
const minutesMarkdown = document.getElementById("minutes-markdown");
const statusLine = document.getElementById("status");
const languageSelect = document.getElementById("language");
const fileInput = document.getElementById("audio-file");
const summarizeButton = document.getElementById("summarize");
const minutesButton = document.getElementById("minutes");
const copyTranscriptButton = document.getElementById("copy-transcript-md");
const copySummaryButton = document.getElementById("copy-summary-md");
const copyMinutesButton = document.getElementById("copy-minutes-md");

let mediaRecorder;
let chunks = [];
let isRecording = false;
let recordedBlob = null;

const setStatus = (message) => {
  statusLine.textContent = message;
};

const renderMarkdown = (markdown, targetElement) => {
  if (!targetElement) return;
  if (!markdown?.trim()) {
    targetElement.innerHTML = "";
    return;
  }

  const unsafe = window.marked?.parse(markdown) || markdown;
  const safe = window.DOMPurify?.sanitize(unsafe) || unsafe;
  targetElement.innerHTML = safe;
};

const copyMarkdown = async (text, label) => {
  if (!text?.trim()) {
    setStatus(`No ${label} markdown to copy.`);
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    setStatus(`${label} markdown copied.`);
  } catch (error) {
    setStatus(`Clipboard error: ${error.message}`);
  }
};

const postJSON = async (url, payload) => {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Request failed.");
  }

  return data;
};

const startRecording = async () => {
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus("Audio recording is not supported in this browser.");
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(stream);
    chunks = [];

    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        chunks.push(event.data);
      }
    };

    mediaRecorder.onstop = () => {
      recordedBlob = new Blob(chunks, { type: mediaRecorder.mimeType || "audio/webm" });
      stream.getTracks().forEach((track) => track.stop());
      setStatus("Recording captured. Click 'Transcribe audio'.");
    };

    mediaRecorder.start();
    isRecording = true;
    recordButton.disabled = true;
    stopButton.disabled = false;
    setStatus("Recording...");
  } catch (error) {
    setStatus(`Microphone error: ${error.message}`);
  }
};

const stopRecording = () => {
  if (!mediaRecorder || mediaRecorder.state !== "recording") {
    return;
  }

  mediaRecorder.stop();
  isRecording = false;
  recordButton.disabled = false;
  stopButton.disabled = true;
};

const selectedAudioFile = () => {
  if (fileInput.files.length > 0) {
    return fileInput.files[0];
  }

  if (recordedBlob) {
    return new File([recordedBlob], "recording.webm", {
      type: recordedBlob.type || "audio/webm",
    });
  }

  return null;
};

const transcribeAudio = async () => {
  const audioFile = selectedAudioFile();
  if (!audioFile) {
    setStatus("Select an audio file or record audio first.");
    return;
  }

  try {
    transcribeButton.disabled = true;
    setStatus("Transcribing...");

    const formData = new FormData();
    formData.append("audio", audioFile);
    formData.append("language", languageSelect.value);

    const response = await fetch("/api/transcribe", {
      method: "POST",
      body: formData,
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Transcription failed.");
    }

    const text = data.transcript || "";
    transcript.value = transcript.value ? `${transcript.value}\n${text}` : text;
    renderMarkdown(transcript.value, transcriptPreview);
    setStatus("Transcription complete.");
  } catch (error) {
    setStatus(error.message);
  } finally {
    transcribeButton.disabled = false;
  }
};

const generateOutputs = async () => {
  const text = transcript.value.trim();
  if (!text) {
    setStatus("Add transcript text first.");
    return null;
  }

  setStatus("Generating summary and minutes...");
  const data = await postJSON("/api/analyze", {
    transcript: text,
    language: languageSelect.value,
  });
  setStatus("Summary and minutes ready.");
  return data;
};

recordButton.addEventListener("click", startRecording);
stopButton.addEventListener("click", stopRecording);
transcribeButton.addEventListener("click", transcribeAudio);

fileInput.addEventListener("change", () => {
  if (fileInput.files.length > 0) {
    recordedBlob = null;
    setStatus(`Selected: ${fileInput.files[0].name}. Click 'Transcribe audio'.`);
  }
});

languageSelect.addEventListener("change", () => {
  if (isRecording) {
    setStatus("Language changed. Stop current recording before transcribing.");
  }
});

transcript.addEventListener("input", () => {
  renderMarkdown(transcript.value, transcriptPreview);
});

copyTranscriptButton.addEventListener("click", () => copyMarkdown(transcript.value, "Transcript"));
copySummaryButton.addEventListener("click", () => copyMarkdown(summaryMarkdown.value, "Summary"));
copyMinutesButton.addEventListener("click", () => copyMarkdown(minutesMarkdown.value, "Minutes"));

summarizeButton.addEventListener("click", async () => {
  try {
    summarizeButton.disabled = true;
    const data = await generateOutputs();
    if (data) {
      summaryMarkdown.value = data.summary;
      renderMarkdown(data.summary, summaryOutput);
    }
  } catch (error) {
    setStatus(error.message);
  } finally {
    summarizeButton.disabled = false;
  }
});

minutesButton.addEventListener("click", async () => {
  try {
    minutesButton.disabled = true;
    const data = await generateOutputs();
    if (data) {
      minutesMarkdown.value = data.minutes;
      renderMarkdown(data.minutes, minutesOutput);
    }
  } catch (error) {
    setStatus(error.message);
  } finally {
    minutesButton.disabled = false;
  }
});

renderMarkdown(transcript.value, transcriptPreview);
setStatus("Ready. Upload or record audio.");
