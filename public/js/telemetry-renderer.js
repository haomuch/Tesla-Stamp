/**
 * Tesla Telemetry Graphical Overlay Renderer
 * Renders high-DPI Tesla steering wheel (AP), brake pedal, accelerator pedal,
 * turn signals, gear indicator, and speed readout on 2D Canvas.
 *
 * 性能约定：信息栏几乎每帧都要重绘，而 Canvas2D 的 shadowBlur（高斯模糊）
 * 是最昂贵的操作之一。因此所有带阴影的图标都按「离散状态 + 渲染尺寸」
 * 预渲染成离屏小画布并缓存，稳态下每帧只剩几次 drawImage，
 * 外加若干次无阴影的 fillText / fillRect。
 */

// --- 图标缓存 ---
const ICON_CACHE = new Map();
const ICON_CACHE_LIMIT = 256;

const getCachedIcon = (key, w, h, draw) => {
    let canvas = ICON_CACHE.get(key);
    if (canvas) return canvas;
    if (ICON_CACHE.size >= ICON_CACHE_LIMIT) ICON_CACHE.clear();
    canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(w));
    canvas.height = Math.max(1, Math.ceil(h));
    draw(canvas.getContext('2d'));
    ICON_CACHE.set(key, canvas);
    return canvas;
};

const clearIconCache = () => ICON_CACHE.clear();

function getVisualTextY(ctx, centerY, sampleText = "0") {
    ctx.textBaseline = 'middle';
    const m = ctx.measureText(sampleText);
    if (m && m.actualBoundingBoxAscent !== undefined && m.actualBoundingBoxDescent !== undefined) {
        return centerY - (m.actualBoundingBoxDescent - m.actualBoundingBoxAscent) / 2;
    }
    return centerY;
}

function drawRoundRect(ctx, x, y, w, h, r) {
    if (typeof ctx.roundRect === 'function') {
        ctx.roundRect(x, y, w, h, r);
    } else {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + h, r);
        ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r);
        ctx.arcTo(x, y, x + w, y, r);
        ctx.closePath();
    }
}

function drawTeslaAP(ctx, x, centerY, size, apState, fontStack) {
    const isActive = apState && apState !== "NONE" && apState !== "OFF" && apState !== "NULL" && apState !== "--";
    const radius = size * 0.44;
    const pad = Math.ceil(size * 0.32); // shadowBlur = size*0.2，留出扩散余量
    const iconSize = Math.ceil(radius * 2 + pad * 2);
    const mainColor = isActive ? '#3B82F6' : '#9CA3AF';

    // 方向盘（含阴影）→ 按「尺寸 + 激活态」缓存，稳态只有 2 项
    const icon = getCachedIcon(`ap|${iconSize}|${isActive ? 1 : 0}`, iconSize, iconSize, (c) => {
        const cx = iconSize / 2;
        const cy = iconSize / 2;

        c.save();

        if (isActive) {
            c.shadowColor = 'rgba(59, 130, 246, 0.4)';
            c.shadowBlur = size * 0.2;
        }

        // 1. Outer Steering Wheel Rim
        const rimLineWidth = Math.max(1.8, size * 0.09);
        c.beginPath();
        c.arc(cx, cy, radius - rimLineWidth * 0.5, 0, Math.PI * 2);
        c.lineWidth = rimLineWidth;
        c.strokeStyle = mainColor;
        c.stroke();

        // 2. Center Airbag Hub
        const hubR = radius * 0.38;
        c.beginPath();
        c.arc(cx, cy, hubR, 0, Math.PI * 2);
        c.fillStyle = mainColor;
        c.fill();

        // 3. Three Clean Spokes (Left, Right, Bottom)
        const spokeLineWidth = Math.max(1.5, size * 0.08);
        const rimInnerRadius = radius - rimLineWidth;

        c.beginPath();
        c.lineWidth = spokeLineWidth;
        c.strokeStyle = mainColor;
        c.lineCap = 'round';

        c.moveTo(cx - hubR, cy);
        c.lineTo(cx - rimInnerRadius, cy);

        c.moveTo(cx + hubR, cy);
        c.lineTo(cx + rimInnerRadius, cy);

        c.moveTo(cx, cy + hubR);
        c.lineTo(cx, cy + rimInnerRadius);
        c.stroke();

        // 4. Crisp Tesla 'T' Logo inside Center Hub
        const tW = hubR * 0.7;
        const tH = hubR * 0.65;
        const tY = cy - tH * 0.35;

        c.beginPath();
        c.moveTo(cx - tW * 0.5, tY);
        c.quadraticCurveTo(cx, tY + tH * 0.15, cx + tW * 0.5, tY);
        c.moveTo(cx, tY + tH * 0.1);
        c.lineTo(cx, tY + tH);

        c.lineWidth = Math.max(1, size * 0.045);
        c.lineCap = 'round';
        c.strokeStyle = isActive ? '#FFFFFF' : '#1F2937';
        c.stroke();

        c.restore();
    });
    ctx.drawImage(icon, x - pad, centerY - iconSize / 2);

    // 5. AP Status Text（无阴影，直接绘制）
    const textX = x + radius * 2 + size * 0.25;
    let displayLabel = "NONE";
    if (isActive) {
        const s = String(apState).toUpperCase();
        if (s.includes("FULL") || s.includes("FSD") || s.includes("SELF") || s === "3") {
            displayLabel = "FULL";
        } else if (s.includes("AUTO") || s.includes("STEER") || s.includes("PILOT") || s.includes("LANE") || s === "2") {
            displayLabel = "AUTO";
        } else if (s.includes("TACC") || s.includes("ACC") || s.includes("CRUISE") || s === "1") {
            displayLabel = "TACC";
        } else {
            displayLabel = apState;
        }
    }

    ctx.save();
    ctx.font = `400 ${size}px ${fontStack}`;
    ctx.textAlign = 'left';
    ctx.fillStyle = mainColor;
    ctx.fillText(displayLabel, textX, getVisualTextY(ctx, centerY, "0"));
    ctx.restore();
}

function drawTeslaBrake(ctx, x, centerY, size, isBrakeOn) {
    const pedalW = size * 1.05;
    const pedalH = size * 0.85;
    const pedalR = size * 0.12;
    const pad = Math.ceil(size * 0.48); // shadowBlur = size*0.3
    const iconW = Math.ceil(pedalW + pad * 2);
    const iconH = Math.ceil(pedalH + pad * 2);

    // 踏板（含阴影）→ 按「尺寸 + 踩下态」缓存，稳态只有 2 项
    const icon = getCachedIcon(`brake|${iconW}|${isBrakeOn ? 1 : 0}`, iconW, iconH, (c) => {
        c.save();

        if (isBrakeOn) {
            c.shadowColor = 'rgba(232, 33, 39, 0.5)';
            c.shadowBlur = size * 0.3;
        }

        // Tesla Brake Pedal Face Plate
        c.beginPath();
        drawRoundRect(c, pad, pad, pedalW, pedalH, pedalR);
        c.fillStyle = isBrakeOn ? '#E82127' : '#2D333B';
        c.fill();
        c.lineWidth = Math.max(1.2, size * 0.05);
        c.strokeStyle = isBrakeOn ? '#FF6B6B' : '#4B5563';
        c.stroke();

        // Anti-slip Rubber Grip Stripes (3 vertical bars)
        const gripW = pedalW * 0.14;
        const gripH = pedalH * 0.58;
        const gripY = pad + pedalH * 0.5 - gripH * 0.5;
        const gripR = gripW * 0.4;
        const gripGap = pedalW * 0.15;
        const startX = pad + (pedalW - (3 * gripW + 2 * gripGap)) * 0.5;

        c.fillStyle = isBrakeOn ? '#FFFFFF' : '#8A929B';
        for (let i = 0; i < 3; i++) {
            const gx = startX + i * (gripW + gripGap);
            c.beginPath();
            drawRoundRect(c, gx, gripY, gripW, gripH, gripR);
            c.fill();
        }

        c.restore();
    });

    ctx.drawImage(icon, x - pad, centerY - pedalH * 0.5 - pad);
}

function drawTeslaAccel(ctx, x, centerY, size, accelNum, fontStack) {
    const isValValid = typeof accelNum === 'number' && !isNaN(accelNum);
    const pct = isValValid ? Math.min(100, Math.max(0, accelNum)) : 0;
    const isAccelerating = pct > 0;
    const mainColor = isAccelerating ? '#10B981' : '#8A929B';

    // 1. 油门踏板（含阴影）→ 缓存
    const pedalW = size * 0.52;
    const pedalH = size * 0.85;
    const pedalR = size * 0.1;
    const pad = Math.ceil(size * 0.4); // shadowBlur = size*0.25
    const iconW = Math.ceil(pedalW + pad * 2);
    const iconH = Math.ceil(pedalH + pad * 2);

    const icon = getCachedIcon(`accel|${iconW}|${isAccelerating ? 1 : 0}`, iconW, iconH, (c) => {
        c.save();

        if (isAccelerating) {
            c.shadowColor = 'rgba(16, 185, 129, 0.4)';
            c.shadowBlur = size * 0.25;
        }

        c.beginPath();
        drawRoundRect(c, pad, pad, pedalW, pedalH, pedalR);
        c.fillStyle = isAccelerating ? '#064E3B' : '#2D333B';
        c.fill();
        c.lineWidth = Math.max(1.2, size * 0.05);
        c.strokeStyle = isAccelerating ? '#10B981' : '#4B5563';
        c.stroke();

        // Vertical Rubber Ribs (2 vertical bars)
        const ribW = pedalW * 0.16;
        const ribH = pedalH * 0.6;
        const ribY = pad + pedalH * 0.5 - ribH * 0.5;
        const ribGap = pedalW * 0.18;
        const ribStartX = pad + (pedalW - (2 * ribW + ribGap)) * 0.5;

        c.fillStyle = isAccelerating ? '#D1FAE5' : '#8A929B';
        for (let i = 0; i < 2; i++) {
            const rx = ribStartX + i * (ribW + ribGap);
            c.beginPath();
            drawRoundRect(c, rx, ribY, ribW, ribH, ribW * 0.4);
            c.fill();
        }

        c.restore();
    });
    ctx.drawImage(icon, x - pad, centerY - pedalH * 0.5 - pad);

    // 2. 分段能量条（无阴影，直接绘制）
    const barX = x + pedalW + size * 0.18;
    const barW = size * 1.5;
    const barH = size * 0.55;
    const barY = centerY - barH * 0.5;
    const numSegments = 10;
    const segGap = size * 0.04;
    const segW = (barW - (numSegments - 1) * segGap) / numSegments;
    const activeCount = Math.round((pct / 100) * numSegments);

    ctx.save();
    for (let i = 0; i < numSegments; i++) {
        const sx = barX + i * (segW + segGap);
        const isActiveSeg = i < activeCount && pct > 0;

        ctx.beginPath();
        drawRoundRect(ctx, sx, barY, segW, barH, size * 0.05);
        ctx.fillStyle = isActiveSeg ? '#10B981' : '#262E38';
        ctx.fill();

        if (isActiveSeg) {
            ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
            ctx.fillRect(sx, barY, segW, barH * 0.25);
        }
    }
    ctx.restore();

    // 3. Percentage Readout
    const textX = barX + barW + size * 0.2;
    ctx.save();
    ctx.font = `400 ${size}px ${fontStack}`;
    ctx.fillStyle = mainColor;
    const textCenterY = getVisualTextY(ctx, centerY, "0");

    const dW = ctx.measureText("0").width;
    const numStr = isValValid ? pct.toString() : "--";
    const numDigits = Math.max(2, numStr.length);
    const percentX = textX + numDigits * dW;

    ctx.textAlign = 'right';
    ctx.fillText(numStr, percentX, textCenterY);

    ctx.textAlign = 'left';
    ctx.fillText("%", percentX, textCenterY);
    ctx.restore();
}

function drawTeslaGear(ctx, x, centerY, size, gearStr, fontStack) {
    ctx.save();
    ctx.font = `700 ${size}px ${fontStack}`;
    ctx.textAlign = 'left';
    ctx.fillStyle = '#3B82F6';
    const textCenterY = getVisualTextY(ctx, centerY, gearStr || "D");
    ctx.fillText(gearStr, x, textCenterY);
    ctx.restore();
}

function drawTeslaBlinkers(ctx, x, centerY, size, isLeftOn, isRightOn, blinkPhase = 1) {
    const activeLeft = isLeftOn && (blinkPhase === 1);
    const activeRight = isRightOn && (blinkPhase === 1);

    const arrowW = size * 0.55;
    const arrowH = size * 0.65;
    const headW = arrowW * 0.55;
    const stemH = arrowH * 0.42;
    const gap = size * 0.75;
    const pad = Math.ceil(size * 0.62); // shadowBlur = size*0.4
    const iconW = Math.ceil(arrowW * 2 + gap + pad * 2);
    const iconH = Math.ceil(arrowH + pad * 2);

    // 0=灭 1=暗（开启但处于闪烁相位） 2=亮（带阴影）
    const leftState = activeLeft ? 2 : (isLeftOn ? 1 : 0);
    const rightState = activeRight ? 2 : (isRightOn ? 1 : 0);

    const icon = getCachedIcon(`blinker|${iconW}|${leftState}|${rightState}`, iconW, iconH, (c) => {
        const cy = pad + arrowH * 0.5;

        const pathLeftArrow = (lx) => {
            c.beginPath();
            c.moveTo(lx, cy);
            c.lineTo(lx + headW, cy - arrowH * 0.5);
            c.lineTo(lx + headW, cy - stemH * 0.5);
            c.lineTo(lx + arrowW, cy - stemH * 0.5);
            c.lineTo(lx + arrowW, cy + stemH * 0.5);
            c.lineTo(lx + headW, cy + stemH * 0.5);
            c.lineTo(lx + headW, cy + arrowH * 0.5);
            c.closePath();
        };

        const pathRightArrow = (lx) => {
            c.beginPath();
            c.moveTo(lx + arrowW, cy);
            c.lineTo(lx + arrowW - headW, cy - arrowH * 0.5);
            c.lineTo(lx + arrowW - headW, cy - stemH * 0.5);
            c.lineTo(lx, cy - stemH * 0.5);
            c.lineTo(lx, cy + stemH * 0.5);
            c.lineTo(lx + arrowW - headW, cy + stemH * 0.5);
            c.lineTo(lx + arrowW - headW, cy + arrowH * 0.5);
            c.closePath();
        };

        c.save();
        c.lineJoin = 'round';
        c.lineWidth = Math.max(1, size * 0.04);

        // Left Turn Signal Arrow
        if (leftState === 2) {
            c.shadowColor = 'rgba(16, 185, 129, 0.8)';
            c.shadowBlur = size * 0.4;
            c.fillStyle = '#10B981';
            c.strokeStyle = '#34D399';
        } else {
            c.shadowBlur = 0;
            c.fillStyle = leftState === 1 ? '#1F3A2B' : '#2D333B';
            c.strokeStyle = leftState === 1 ? '#059669' : '#4B5563';
        }
        pathLeftArrow(pad);
        c.fill();
        c.stroke();

        // Right Turn Signal Arrow
        if (rightState === 2) {
            c.shadowColor = 'rgba(16, 185, 129, 0.8)';
            c.shadowBlur = size * 0.4;
            c.fillStyle = '#10B981';
            c.strokeStyle = '#34D399';
        } else {
            c.shadowBlur = 0;
            c.fillStyle = rightState === 1 ? '#1F3A2B' : '#2D333B';
            c.strokeStyle = rightState === 1 ? '#059669' : '#4B5563';
        }
        pathRightArrow(pad + arrowW + gap);
        c.fill();
        c.stroke();

        c.restore();
    });

    ctx.drawImage(icon, x - pad, centerY - arrowH * 0.5 - pad);
}

window.TelemetryRenderer = {
    getVisualTextY,
    drawRoundRect,
    drawTeslaAP,
    drawTeslaBrake,
    drawTeslaAccel,
    drawTeslaGear,
    drawTeslaBlinkers,
    clearIconCache
};
