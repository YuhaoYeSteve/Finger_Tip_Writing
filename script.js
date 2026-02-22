const videoElement = document.querySelector('.input_video');
const canvasElement = document.querySelector('.output_canvas');
const canvasCtx = canvasElement.getContext('2d');
const loadingOverlay = document.getElementById('loading');
const clearBtn = document.getElementById('clear-btn');
const toggleCameraBtn = document.getElementById('toggle-camera-btn');
const recordBtn = document.getElementById('record-btn');
const saveBtn = document.getElementById('save-btn');
const colorPicker = document.getElementById('color-picker');
const lineWidthInput = document.getElementById('line-width');
const sensitivityInput = document.getElementById('sensitivity');

// 绘图配置
let drawingColor = colorPicker.value;
let drawingLineWidth = parseInt(lineWidthInput.value);
let sensitivity = parseFloat(sensitivityInput.value); // 默认 0.5
let isCameraActive = true;
let isFirstFrame = true;

// 状态追踪
let lostTrackingFrames = 0;
const LOST_TRACKING_THRESHOLD = 30; // 约1秒未检测到则提示

// 录制相关
let mediaRecorder;
let recordedChunks = [];
let isRecording = false;

// 离屏 Canvas 用于持久化笔迹
const drawingCanvas = document.createElement('canvas');
const drawingCtx = drawingCanvas.getContext('2d');

let lastPoint = null;
let isPinching = false; // 当前捏合状态
let pinchCooldown = 0; // 松开缓冲计数器

// 初始化离屏 Canvas
function initDrawingCanvas() {
    drawingCanvas.width = canvasElement.width;
    drawingCanvas.height = canvasElement.height;
    drawingCtx.lineCap = 'round';
    drawingCtx.lineJoin = 'round';
}

// 事件监听
colorPicker.addEventListener('input', (e) => {
    drawingColor = e.target.value;
});

lineWidthInput.addEventListener('input', (e) => {
    drawingLineWidth = parseInt(e.target.value);
});

sensitivityInput.addEventListener('input', (e) => {
    // 界面显示：0.2 (高灵敏/左) -> 0.8 (低灵敏/右)
    // 实际设置：minConfidence 越小越灵敏
    // 方案：让用户直观地调节“灵敏度”。
    // 滑块向右(数值变大) -> 灵敏度变高 -> minConfidence 变小
    // 当前 HTML: min=0.2, max=0.8. 
    // 假设用户向左滑(0.2)，我们希望是高灵敏，那么 minConfidence 设为 0.2
    // 假设用户向右滑(0.8)，我们希望是低灵敏，那么 minConfidence 设为 0.8
    // 结论：直接使用 value 作为 minConfidence 即可。
    // 但是 HTML Label 说是“左高右低”，那意味着左边(0.2)应该是高灵敏(Confidence=0.2)，右边(0.8)是低灵敏(Confidence=0.8)。
    // 所以直接用 e.target.value 传给 MediaPipe 没问题。
    
    const val = parseFloat(e.target.value);
    
    hands.setOptions({
        minDetectionConfidence: val,
        minTrackingConfidence: val
    });
});

clearBtn.addEventListener('click', () => {
    drawingCtx.clearRect(0, 0, drawingCanvas.width, drawingCanvas.height);
});

toggleCameraBtn.addEventListener('click', () => {
    isCameraActive = !isCameraActive;
    if (isCameraActive) {
        camera.start();
        toggleCameraBtn.textContent = "暂停摄像头";
        toggleCameraBtn.classList.remove('secondary');
        toggleCameraBtn.classList.add('primary');
    } else {
        camera.stop();
        toggleCameraBtn.textContent = "开启摄像头";
        toggleCameraBtn.classList.remove('primary');
        toggleCameraBtn.classList.add('secondary');
    }
});

// 保存截图
saveBtn.addEventListener('click', () => {
    const link = document.createElement('a');
    link.download = `finger-writing-${Date.now()}.png`;
    link.href = canvasElement.toDataURL();
    link.click();
});

// 录制视频
const handleRecording = () => {
    if (!isRecording) {
        // 开始录制
        const stream = canvasElement.captureStream(30); // 30 FPS
        const options = { mimeType: 'video/webm;codecs=vp9' };
        
        // 兼容性检查
        if (!MediaRecorder.isTypeSupported(options.mimeType)) {
            console.warn(`${options.mimeType} is not supported, trying default.`);
            delete options.mimeType;
        }

        try {
            mediaRecorder = new MediaRecorder(stream, options);
        } catch (e) {
            console.error('MediaRecorder error:', e);
            alert('无法启动录制，请确保浏览器支持 MediaRecorder API。');
            return;
        }

        recordedChunks = [];
        mediaRecorder.ondataavailable = (event) => {
            if (event.data.size > 0) {
                recordedChunks.push(event.data);
            }
        };

        mediaRecorder.onstop = () => {
            const blob = new Blob(recordedChunks, {
                type: 'video/webm'
            });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = `finger-writing-video-${Date.now()}.webm`;
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 100);
        };

        mediaRecorder.start();
        isRecording = true;
        recordBtn.textContent = "停止录制";
        recordBtn.classList.add('recording');
    } else {
        // 停止录制
        mediaRecorder.stop();
        isRecording = false;
        recordBtn.textContent = "开始录制";
        recordBtn.classList.remove('recording');
    }
};

recordBtn.addEventListener('click', handleRecording);

function onResults(results) {
    if (isFirstFrame) {
        loadingOverlay.classList.add('hidden');
        // 初始化 Canvas 尺寸
        canvasElement.width = videoElement.videoWidth;
        canvasElement.height = videoElement.videoHeight;
        initDrawingCanvas();
        isFirstFrame = false;
    }

    // 1. 清空主 Canvas
    canvasCtx.save();
    canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);

    // 2. 绘制摄像头画面
    // 注意：我们在 CSS 中已经做了镜像翻转，这里直接绘制即可
    canvasCtx.drawImage(results.image, 0, 0, canvasElement.width, canvasElement.height);

    // 3. 绘制持久化的笔迹
    canvasCtx.drawImage(drawingCanvas, 0, 0);

    // 4. 处理手部检测结果
    if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
        lostTrackingFrames = 0; // 重置丢失计数
        const tip = document.querySelector('.guide-tip');
        tip.textContent = "提示：捏合食指和拇指即可开始书写，松开停止";
        tip.style.color = ""; // 恢复默认颜色

        // 我们只取第一只手
        const landmarks = results.multiHandLandmarks[0];

        // 绘制手部骨架 (辅助显示)
        drawConnectors(canvasCtx, landmarks, HAND_CONNECTIONS, {color: '#FFFFFF', lineWidth: 1});
        drawLandmarks(canvasCtx, landmarks, {color: '#FF0000', lineWidth: 1, radius: 2});

        // 获取食指指尖 (Index Finger Tip, ID=8) 和 拇指指尖 (Thumb Tip, ID=4)
        const indexTip = landmarks[8];
        const thumbTip = landmarks[4];
        
        // 转换坐标 (0-1 -> 像素)
        let indexX = indexTip.x * canvasElement.width;
        let indexY = indexTip.y * canvasElement.height;
        let thumbX = thumbTip.x * canvasElement.width;
        let thumbY = thumbTip.y * canvasElement.height;

        // 简单的平滑处理 (Exponential Moving Average)
        if (lastPoint && lastPoint.rawIndex) {
            const alpha = 0.5; // 平滑系数
            indexX = lastPoint.rawIndex.x * (1 - alpha) + indexX * alpha;
            indexY = lastPoint.rawIndex.y * (1 - alpha) + indexY * alpha;
            thumbX = lastPoint.rawThumb.x * (1 - alpha) + thumbX * alpha;
            thumbY = lastPoint.rawThumb.y * (1 - alpha) + thumbY * alpha;
        }

        // 计算食指和拇指的距离 (使用平滑后的坐标计算距离，视觉更稳定)
        const pinchDistance = Math.hypot(indexX - thumbX, indexY - thumbY) / canvasElement.width; // 归一化距离需要重新估算，或者直接用像素距离
        // 之前用的是 indexTip.x (0-1)，现在有了像素坐标，但为了保持逻辑一致，我们还是用原始 landmark 计算状态
        const rawPinchDistance = Math.hypot(indexTip.x - thumbTip.x, indexTip.y - thumbTip.y);
        
        // 迟滞阈值 (Hysteresis)
        const PINCH_START = 0.05; // 开始捏合的阈值
        const PINCH_STOP = 0.08;  // 停止捏合的阈值
        const PINCH_BUFFER_FRAMES = 5; // 松开缓冲帧数

        if (rawPinchDistance < PINCH_START) {
            isPinching = true;
            pinchCooldown = PINCH_BUFFER_FRAMES; // 重置缓冲
        } else if (rawPinchDistance > PINCH_STOP) {
            if (pinchCooldown > 0) {
                pinchCooldown--;
                isPinching = true;
            } else {
                isPinching = false;
            }
        } else {
            if (isPinching) {
                pinchCooldown = PINCH_BUFFER_FRAMES;
            }
        }

        // 确定绘图目标点 (Target Point)
        let targetX, targetY;
        
        if (isPinching) {
            // 捏合状态：使用两指中间点
            targetX = (indexX + thumbX) / 2;
            targetY = (indexY + thumbY) / 2;
        } else {
            // 悬停状态：使用食指指尖
            targetX = indexX;
            targetY = indexY;
        }

        // 绘制可视化指示器
        if (isPinching) {
            // 1. 捏合时：在中间显示红色实心圆
            canvasCtx.beginPath();
            canvasCtx.arc(targetX, targetY, 8, 0, 2 * Math.PI);
            canvasCtx.fillStyle = 'red'; // 红色代表书写状态
            canvasCtx.fill();
            canvasCtx.strokeStyle = 'white';
            canvasCtx.lineWidth = 2;
            canvasCtx.stroke();
        } else {
            // 2. 悬停时：分别显示食指和拇指的空心圈
            // 食指圈 (Drawing Color)
            canvasCtx.beginPath();
            canvasCtx.arc(indexX, indexY, 12, 0, 2 * Math.PI);
            canvasCtx.strokeStyle = drawingColor;
            canvasCtx.lineWidth = 3;
            canvasCtx.stroke();
            
            // 拇指圈 (跟随画笔颜色)
            canvasCtx.beginPath();
            canvasCtx.arc(thumbX, thumbY, 12, 0, 2 * Math.PI);
            canvasCtx.strokeStyle = drawingColor;
            canvasCtx.lineWidth = 3; // 保持一致的粗细
            canvasCtx.stroke();
        }

        // 书写逻辑
        if (isPinching) {
            // 如果上一帧也是捏合状态，或者在缓冲期内，则连线
            if (lastPoint && lastPoint.wasPinching) {
                const dist = Math.hypot(targetX - lastPoint.x, targetY - lastPoint.y);
                // 放宽防抖动限制
                if (dist < 300) {
                    drawingCtx.beginPath();
                    drawingCtx.moveTo(lastPoint.x, lastPoint.y);
                    drawingCtx.lineTo(targetX, targetY);
                    drawingCtx.strokeStyle = drawingColor;
                    drawingCtx.lineWidth = drawingLineWidth;
                    drawingCtx.stroke();
                } else {
                    drawingCtx.beginPath();
                    drawingCtx.moveTo(targetX, targetY);
                }
            }
        }
        
        // 更新 lastPoint，同时保存原始坐标用于下一帧平滑
        lastPoint = { 
            x: targetX, 
            y: targetY, 
            wasPinching: isPinching,
            rawIndex: { x: indexX, y: indexY },
            rawThumb: { x: thumbX, y: thumbY }
        };
    } else {
        lastPoint = null;
        lostTrackingFrames++;
        
        if (lostTrackingFrames > LOST_TRACKING_THRESHOLD) {
            const tip = document.querySelector('.guide-tip');
            tip.textContent = "未检测到手部，请调整光线或距离 (强光/逆光会导致识别失败)";
            tip.style.color = "#dc3545"; // 红色警示
        }
    }

    canvasCtx.restore();
}

// 初始化 MediaPipe Hands
const hands = new Hands({locateFile: (file) => {
    return `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`;
}});

hands.setOptions({
    maxNumHands: 1,
    modelComplexity: 1,
    minDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5
});

hands.onResults(onResults);

// 初始化摄像头
const camera = new Camera(videoElement, {
    onFrame: async () => {
        if (isCameraActive) {
            await hands.send({image: videoElement});
        }
    },
    width: 1280,
    height: 720
});

camera.start();
