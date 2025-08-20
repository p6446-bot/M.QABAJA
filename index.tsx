/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { GoogleGenAI, Chat } from "@google/genai";

// --- Type Definitions ---
type ComponentType =
  'battery' | 'resistor' | 'led' | 'switch' | // Schematic
  'generator' | 'transformer' | 'bus' | 'breaker' | 'load'; // Single-Line

interface DiagramComponent {
  id: string;
  type: ComponentType;
  x: number;
  y: number;
  label: string;
  state?: 'open' | 'closed'; // for switch/breaker
  width?: number; // for bus
}

interface DiagramConnection {
  from: string;
  to: string;
}

interface DiagramData {
  diagramType?: 'schematic' | 'single-line';
  width: number;
  height: number;
  components: DiagramComponent[];
  connections: DiagramConnection[];
}

// --- DOM Elements ---
const chatContainer = document.getElementById('chat-container') as HTMLElement;
const promptForm = document.getElementById('prompt-form') as HTMLFormElement;
const promptInput = document.getElementById('prompt-input') as HTMLInputElement;
const formButton = promptForm.querySelector('button') as HTMLButtonElement;
const fileInput = document.getElementById('file-input') as HTMLInputElement;
const filePreviewContainer = document.getElementById('file-preview-container') as HTMLElement;
const filePreviewImage = document.getElementById('file-preview-image') as HTMLImageElement;
const filePreviewName = document.getElementById('file-preview-name') as HTMLElement;
const removeFileButton = document.getElementById('remove-file-button') as HTMLButtonElement;


// --- State ---
interface SelectedFile {
  file: File;
  base64: string;
  mimeType: string;
}
let ai: GoogleGenAI | null = null;
let chat: Chat | null = null;
let selectedFile: SelectedFile | null = null;

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Initializes the application and sets up the Gemini chat.
 */
async function initializeApp() {
  try {
    ai = new GoogleGenAI({ apiKey: process.env.API_KEY as string });
    chat = ai.chats.create({
      model: 'gemini-2.5-flash',
      config: {
        systemInstruction: `أنت مساعد خبير متعدد المواهب في مجال الطاقة المتجددة والأنظمة الكهربائية. استخدم اللغة العربية في ردودك النصية. لديك ثلاث قدرات خاصة:

1.  **توليد الصور**: إذا طلب المستخدم صورة (مثل "ارسم صورة لـ" أو "تخيل")، قم بالرد فقط بكائن JSON يحتوي على مفتاح "action" بقيمة "generate_image" ومفتاح "prompt" يحتوي على وصف إنجليزي مفصل ومناسب لنموذج تحويل النص إلى صورة. مثال:
    \`\`\`json
    {"action": "generate_image", "prompt": "A photorealistic image of a vast solar farm in the desert at sunset, with shimmering panels."}
    \`\`\`

2.  **رسم المخططات الكهربائية (Schematics)**: إذا طلب المستخدم مخططًا لدائرة كهربائية بسيطة (مثل "ارسم دائرة ببطارية ومصباح")، قم بالرد فقط بكائن JSON داخل كتلة كود markdown (\`\`\`json ... \`\`\`). يجب أن يحتوي JSON على 'width', 'height', 'components' (الأنواع: 'battery', 'switch', 'led', 'resistor'), و 'connections'.

3.  **رسم المخططات الأحادية (Single-Line Diagrams)**: إذا طلب المستخدم مخططًا أحادي الخط لنظام طاقة (مثل "ارسم مخططًا أحادي الخط لمحطة طاقة شمسية")، قم بالرد فقط بكائن JSON داخل كتلة كود markdown. يجب أن يحتوي هذا JSON على 'diagramType' بقيمة 'single-line', 'width', 'height', 'components' (الأنواع: 'generator', 'transformer', 'bus', 'breaker', 'load'), و 'connections'. بالنسبة لمكونات 'bus'، يجب أن يكون الطرف رقمًا يمثل الإزاحة الأفقية من المركز (على سبيل المثال، "b1.-40").

لجميع الطلبات الأخرى، قدم إجابات نصية واضحة وموجزة ومفيدة. لا تقم بتضمين أي نص أو شرح آخر خارج كائن JSON عند تقديم مخطط أو طلب صورة.`
      },
    });
    addInitialMessage();
    promptForm.addEventListener('submit', handleFormSubmit);
    fileInput.addEventListener('change', handleFileSelect);
    removeFileButton.addEventListener('click', clearSelectedFile);
    promptInput.disabled = false;
    formButton.disabled = false;
  } catch (error) {
    console.error('Initialization failed:', error);
    displayError('فشل تهيئة التطبيق. يرجى التحقق من إعداداتك والمحاولة مرة أخرى.');
  }
}

/**
 * Displays the initial welcome message from the model.
 */
function addInitialMessage() {
  addMessage('model', 'مرحباً! كيف يمكنني مساعدتك اليوم في استفساراتك حول الطاقة المتجددة؟ يمكنني أيضًا إنشاء صور ورسم مخططات كهربائية.');
}

/**
 * Renders plain text into a message element.
 * @param {string} text - The text to render.
 * @param {HTMLElement} element - The container element.
 */
function renderAsText(text: string, element: HTMLElement) {
    let textElement = element.querySelector('p');
    if (!textElement) {
      textElement = document.createElement('p');
      element.appendChild(textElement);
    }
    textElement.innerText = text;
}

/**
 * Handles the submission of the user's prompt.
 * @param {SubmitEvent} event - The form submission event.
 */
async function handleFormSubmit(event: SubmitEvent) {
  event.preventDefault();
  if (!chat) return;

  const prompt = promptInput.value.trim();
  if (!prompt && !selectedFile) return;

  const userMessageImage = selectedFile?.base64;
  const fileToSend = selectedFile;

  addMessage('user', prompt, userMessageImage);
  promptForm.reset();
  clearSelectedFile();
  setFormState(true);

  const modelMessageElement = addMessage('model', '');
  const loadingIndicator = document.createElement('div');
  loadingIndicator.className = 'loading';
  loadingIndicator.innerHTML = '<span></span><span></span><span></span>';
  modelMessageElement.appendChild(loadingIndicator);
  
  scrollToBottom();

  try {
    const messageParts: ({ text: string } | { inlineData: { data: string; mimeType: string; } })[] = [];
    if (prompt) messageParts.push({ text: prompt });
    if (fileToSend) {
      const base64Data = fileToSend.base64.split(',')[1];
      messageParts.push({ inlineData: { data: base64Data, mimeType: fileToSend.mimeType } });
    }

    const stream = await chat.sendMessageStream({ message: messageParts });
    let fullResponse = '';
    let firstChunk = true;

    for await (const chunk of stream) {
      if (firstChunk) {
        modelMessageElement.removeChild(loadingIndicator);
        firstChunk = false;
      }
      fullResponse += chunk.text;
      renderAsText(fullResponse, modelMessageElement);
      scrollToBottom();
    }
    
    // After stream is complete, check for special JSON responses
    let parsedJson = null;
    try {
      // Try parsing the whole response as JSON first (for image generation action)
      parsedJson = JSON.parse(fullResponse);
    } catch (e) {
      // If it fails, check for markdown-wrapped JSON (for diagrams)
      const jsonMatch = fullResponse.match(/```json\n([\s\S]*?)\n```/);
      if (jsonMatch && jsonMatch[1]) {
        try {
          parsedJson = JSON.parse(jsonMatch[1]);
        } catch (e2) {
          console.error("Failed to parse diagram JSON from markdown:", e2);
          renderAsText(fullResponse, modelMessageElement);
        }
      }
    }

    if (parsedJson) {
      const p = modelMessageElement.querySelector('p');
      if (p) p.remove(); // Clear any rendered text

      if (parsedJson.action === 'generate_image' && parsedJson.prompt) {
        await handleImageGeneration(parsedJson.prompt, modelMessageElement);
      } else if (parsedJson.components && parsedJson.connections) {
        renderDiagram(parsedJson as DiagramData, modelMessageElement);
      } else {
        renderAsText(fullResponse, modelMessageElement);
      }
    }

  } catch (error) {
    console.error('Error sending message:', error);
    displayError('عذرًا، حدث خطأ أثناء معالجة طلبك.');
    modelMessageElement.remove();
  } finally {
    setFormState(false);
    promptInput.focus();
  }
}

/**
 * Handles the generation of an image using the Imagen model.
 * @param {string} prompt - The prompt for the image generation.
 * @param {HTMLElement} modelMessageElement - The message element to update.
 */
async function handleImageGeneration(prompt: string, modelMessageElement: HTMLElement) {
  if (!ai) return;

  const loadingIndicator = document.createElement('div');
  loadingIndicator.className = 'loading';
  loadingIndicator.innerHTML = '<span></span><span></span><span></span>';
  
  const statusText = document.createElement('p');
  statusText.innerText = `جارٍ إنشاء صورة لـ: "${prompt}"...`;
  statusText.style.fontStyle = 'italic';
  
  modelMessageElement.appendChild(statusText);
  modelMessageElement.appendChild(loadingIndicator);
  scrollToBottom();

  try {
    const response = await ai.models.generateImages({
      model: 'imagen-3.0-generate-002',
      prompt: prompt,
      config: {
        numberOfImages: 1,
        outputMimeType: 'image/jpeg',
        aspectRatio: '1:1',
      },
    });

    const base64ImageBytes = response.generatedImages[0].image.imageBytes;
    const imageUrl = `data:image/jpeg;base64,${base64ImageBytes}`;
    
    modelMessageElement.innerHTML = ''; // Clear loading indicators

    const imageElement = document.createElement('img');
    imageElement.src = imageUrl;
    imageElement.alt = prompt;
    modelMessageElement.appendChild(imageElement);

  } catch (error) {
    console.error('Image generation failed:', error);
    modelMessageElement.innerHTML = ''; // Clear loading
    displayError('عذرًا، فشل إنشاء الصورة.');
  } finally {
     scrollToBottom();
  }
}


/**
 * Renders an SVG diagram based on the provided data.
 * @param {DiagramData} data - The parsed JSON data for the diagram.
 * @param {HTMLElement} container - The message element to render the diagram in.
 */
function renderDiagram(data: DiagramData, container: HTMLElement) {
  const diagramContainer = document.createElement('div');
  diagramContainer.className = 'diagram-container';
  
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${data.width} ${data.height}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  if (data.diagramType === 'single-line') {
    svg.classList.add('single-line-diagram');
  }

  const componentMap = new Map(data.components.map(c => [c.id, c]));

  // Draw connections (wires) first
  for (const conn of data.connections) {
    const [fromId, fromTerminal] = conn.from.split('.');
    const [toId, toTerminal] = conn.to.split('.');
    const fromCoords = getTerminalCoords(componentMap.get(fromId), fromTerminal);
    const toCoords = getTerminalCoords(componentMap.get(toId), toTerminal);
    if (fromCoords && toCoords) {
      const wire = document.createElementNS(SVG_NS, 'line');
      wire.setAttribute('x1', fromCoords.x.toString());
      wire.setAttribute('y1', fromCoords.y.toString());
      wire.setAttribute('x2', toCoords.x.toString());
      wire.setAttribute('y2', toCoords.y.toString());
      wire.classList.add('wire');
      svg.appendChild(wire);
    }
  }

  // Draw components on top of wires
  for (const component of data.components) {
    const group = document.createElementNS(SVG_NS, 'g');
    group.setAttribute('transform', `translate(${component.x}, ${component.y})`);
    
    let componentSvg: SVGElement | null = null;
    switch (component.type) {
      case 'battery': componentSvg = drawBattery(); break;
      case 'resistor': componentSvg = drawResistor(); break;
      case 'led': componentSvg = drawLed(); break;
      case 'switch': componentSvg = drawSwitch(component.state); break;
      case 'generator': componentSvg = drawGenerator(); break;
      case 'transformer': componentSvg = drawTransformer(); break;
      case 'bus': componentSvg = drawBus(component.width); break;
      case 'breaker': componentSvg = drawCircuitBreaker(); break;
      case 'load': componentSvg = drawLoad(); break;
    }
    
    if (componentSvg) group.appendChild(componentSvg);

    const label = document.createElementNS(SVG_NS, 'text');
    label.setAttribute('x', '0');
    label.setAttribute('y', '45'); // Adjusted for better spacing
    label.textContent = component.label;
    label.classList.add('component-label');
    group.appendChild(label);
    
    svg.appendChild(group);
  }
  
  diagramContainer.appendChild(svg);
  container.appendChild(diagramContainer);
}

// --- SVG Component Drawing Functions ---
function drawBattery(): SVGElement {
  const g = document.createElementNS(SVG_NS, 'g');
  g.innerHTML = `
    <line x1="0" y1="-20" x2="0" y2="20" class="component-body terminal"/>
    <line x1="-15" y1="-10" x2="15" y2="-10" class="component-body"/>
    <line x1="-10" y1="10" x2="10" y2="10" class="component-body"/>
    <text x="-25" y="-8" font-size="16px" text-anchor="middle">+</text>
    <text x="-20" y="15" font-size="20px" text-anchor="middle">-</text>
  `;
  return g;
}

function drawResistor(): SVGElement {
  const g = document.createElementNS(SVG_NS, 'g');
  g.innerHTML = `
    <line x1="-30" y1="0" x2="-20" y2="0" class="component-body terminal"/>
    <path d="M -20 0 l 5 -10 l 10 20 l 10 -20 l 10 20 l 10 -20 l 5 10" stroke="black" stroke-width="2" fill="none" class="component-body"/>
    <line x1="20" y1="0" x2="30" y2="0" class="component-body terminal"/>
  `;
  return g;
}

function drawLed(): SVGElement {
  const g = document.createElementNS(SVG_NS, 'g');
  g.innerHTML = `
    <line x1="-25" y1="0" x2="0" y2="0" class="component-body terminal"/>
    <line x1="25" y1="0" x2="0" y2="0" class="component-body terminal"/>
    <path d="M 0 -15 l 25 15 l -25 15 z" class="component-body" fill="none"/>
    <line x1="-5" y1="15" x2="25" y2="15" class="component-body"/>
    <g transform="translate(5, -20) rotate(-45)">
        <path d="M 0 0 l 5 5 l -5 5" fill="none" stroke-width="2" class="component-body"/>
        <path d="M 5 0 l 5 5 l -5 5" fill="none" stroke-width="2" class="component-body"/>
    </g>
  `;
  return g;
}

function drawSwitch(state: 'open' | 'closed' = 'open'): SVGElement {
  const g = document.createElementNS(SVG_NS, 'g');
  const rotation = state === 'open' ? '-30' : '0';
  g.innerHTML = `
    <line x1="-30" y1="0" x2="-5" y2="0" class="component-body terminal"/>
    <line x1="30" y1="0" x2="5" y2="0" class="component-body terminal"/>
    <circle cx="-5" cy="0" r="3" class="component-body" fill="#333"/>
    <circle cx="5" cy="0" r="3" class="component-body" fill="#333"/>
    <line x1="-5" y1="0" x2="25" y2="0" class="component-body" transform="rotate(${rotation} -5 0)"/>
  `;
  return g;
}

function drawGenerator(): SVGElement {
    const g = document.createElementNS(SVG_NS, 'g');
    g.innerHTML = `
      <circle cx="0" cy="0" r="20" class="component-body" fill="none"/>
      <path d="M -13 0 Q -6.5 -15 0 0 T 13 0" class="component-symbol"/>
      <line x1="0" y1="20" x2="0" y2="30" class="component-body terminal"/>
    `;
    return g;
}

function drawTransformer(): SVGElement {
    const g = document.createElementNS(SVG_NS, 'g');
    g.innerHTML = `
      <circle cx="0" cy="-8" r="12" class="component-body" fill="none"/>
      <circle cx="0" cy="8" r="12" class="component-body" fill="none"/>
      <line x1="0" y1="-20" x2="0" y2="-30" class="component-body terminal"/>
      <line x1="0" y1="20" x2="0" y2="30" class="component-body terminal"/>
    `;
    return g;
}

function drawBus(width: number = 100): SVGElement {
    const g = document.createElementNS(SVG_NS, 'g');
    g.innerHTML = `<line x1="${-width / 2}" y1="0" x2="${width / 2}" y2="0" class="bus-bar"/>`;
    return g;
}

function drawCircuitBreaker(): SVGElement {
    const g = document.createElementNS(SVG_NS, 'g');
    g.innerHTML = `
        <rect x="-8" y="-8" width="16" height="16" class="component-body" fill="none"/>
        <line x1="-25" y1="0" x2="-8" y2="0" class="component-body terminal"/>
        <line x1="25" y1="0" x2="8" y2="0" class="component-body terminal"/>
    `;
    return g;
}

function drawLoad(): SVGElement {
    const g = document.createElementNS(SVG_NS, 'g');
    g.innerHTML = `
        <line x1="0" y1="-25" x2="0" y2="0" class="component-body terminal"/>
        <path d="M 0 0 L -10 10 L 0 5 L 10 10 Z" class="component-symbol"/>
    `;
    return g;
}

/**
 * Gets the absolute coordinates of a component's terminal.
 * @param {DiagramComponent} component - The component object.
 * @param {string} terminal - The name of the terminal (e.g., 'positive', 'in').
 * @returns {{x: number, y: number} | null} The coordinates or null if not found.
 */
function getTerminalCoords(component: DiagramComponent | undefined, terminal: string): { x: number, y: number } | null {
  if (!component) return null;
  const { x, y, type } = component;
  switch (type) {
    case 'battery':
      return terminal === 'positive' ? { x: x, y: y - 20 } : { x: x, y: y + 20 };
    case 'resistor':
      return terminal === 'in' ? { x: x - 30, y: y } : { x: x + 30, y: y };
    case 'led':
      return terminal === 'anode' ? { x: x - 25, y: y } : { x: x + 25, y: y };
    case 'switch':
      return terminal === 'in' ? { x: x - 30, y: y } : { x: x + 30, y: y };
    case 'generator':
      return { x: x, y: y + 30 };
    case 'transformer':
      return terminal === 'primary' ? { x: x, y: y - 30 } : { x: x, y: y + 30 };
    case 'bus':
      const busOffset = parseFloat(terminal);
      return { x: x + (isNaN(busOffset) ? 0 : busOffset), y: y };
    case 'breaker':
      return terminal === 'in' ? { x: x - 25, y: y } : { x: x + 25, y: y };
    case 'load':
      return { x: x, y: y - 25 };
    default:
      return null;
  }
}


/**
 * Handles the selection of a file.
 * @param {Event} event - The file input change event.
 */
function handleFileSelect(event: Event) {
  const target = event.target as HTMLInputElement;
  const file = target.files?.[0];
  if (!file || !file.type.startsWith('image/')) {
    selectedFile = null;
    updateFilePreview();
    return;
  }

  const reader = new FileReader();
  reader.onload = () => {
    selectedFile = {
      file,
      base64: reader.result as string,
      mimeType: file.type,
    };
    updateFilePreview();
  };
  reader.readAsDataURL(file);
}

/**
 * Updates the UI to show or hide the file preview.
 */
function updateFilePreview() {
  if (selectedFile) {
    filePreviewImage.src = selectedFile.base64;
    filePreviewName.textContent = selectedFile.file.name;
    filePreviewContainer.classList.remove('hidden');
  } else {
    filePreviewContainer.classList.add('hidden');
  }
}

/**
 * Clears the selected file state and hides the preview.
 */
function clearSelectedFile() {
  selectedFile = null;
  fileInput.value = '';
  updateFilePreview();
}

/**
 * Displays an error message in the chat container.
 * @param {string} message - The error message to display.
 */
function displayError(message: string) {
  const errorElement = addMessage('model', message);
  errorElement.style.backgroundColor = '#ffcdd2';
  errorElement.style.color = '#c62828';
}


/**
 * Appends a new message to the chat container.
 * @param {'user' | 'model'} sender - The sender of the message.
 * @param {string} text - The message content.
 * @param {string} [imageUrl] - An optional URL for an image to include.
 * @returns {HTMLElement} The created message element.
 */
function addMessage(sender: 'user' | 'model', text: string, imageUrl?: string): HTMLElement {
  const messageElement = document.createElement('div');
  messageElement.classList.add('message', `${sender}-message`);

  if (imageUrl) {
    const imageElement = document.createElement('img');
    imageElement.src = imageUrl;
    imageElement.alt = sender === 'user' ? 'User uploaded image' : 'Model generated image';
    messageElement.appendChild(imageElement);
  }

  if (text) {
    const textElement = document.createElement('p');
    textElement.innerText = text;
    messageElement.appendChild(textElement);
  }

  chatContainer.appendChild(messageElement);
  scrollToBottom();
  return messageElement;
}

/**
 * Controls the enabled/disabled state of the input form.
 * @param {boolean} isLoading - Whether the form should be in a loading state.
 */
function setFormState(isLoading: boolean) {
  promptInput.disabled = isLoading;
  formButton.disabled = isLoading;
  fileInput.disabled = isLoading;
}

/**
 * Automatically scrolls the chat container to the latest message.
 */
function scrollToBottom() {
  chatContainer.scrollTop = chatContainer.scrollHeight;
}

// --- App Entry Point ---
initializeApp();
