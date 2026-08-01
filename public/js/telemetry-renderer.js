/**
 * Tesla Telemetry Graphical Overlay Renderer
 * Renders high-DPI Tesla steering wheel (AP), brake pedal, accelerator pedal,
 * turn signals, gear indicator, and speed readout on 2D Canvas.
 */

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
    const wheelX = x + radius;
    const wheelY = centerY;

    const mainColor = isActive ? '#3B82F6' : '#9CA3AF';

    ctx.save();

    if (isActive) {
        ctx.shadowColor = 'rgba(59, 130, 246, 0.4)';
        ctx.shadowBlur = size * 0.2;
    }

    // 1. Outer Steering Wheel Rim
    const rimLineWidth = Math.max(1.8, size * 0.09);
    ctx.beginPath();
    ctx.arc(wheelX, wheelY, radius - rimLineWidth * 0.5, 0, Math.PI * 2);
    ctx.lineWidth = rimLineWidth;
    ctx.strokeStyle = mainColor;
    ctx.stroke();

    // 2. Center Airbag Hub
    const hubR = radius * 0.38;
    ctx.beginPath();
    ctx.arc(wheelX, wheelY, hubR, 0, Math.PI * 2);
    ctx.fillStyle = mainColor;
    ctx.fill();

    // 3. Three Clean Spokes (Left, Right, Bottom)
    const spokeLineWidth = Math.max(1.5, size * 0.08);
    const rimInnerRadius = radius - rimLineWidth;

    ctx.beginPath();
    ctx.lineWidth = spokeLineWidth;
    ctx.strokeStyle = mainColor;
    ctx.lineCap = 'round';

    // Left Spoke
    ctx.moveTo(wheelX - hubR, wheelY);
    ctx.lineTo(wheelX - rimInnerRadius, wheelY);

    // Right Spoke
    ctx.moveTo(wheelX + hubR, wheelY);
    ctx.lineTo(wheelX + rimInnerRadius, wheelY);

    // Bottom Vertical Spoke
    ctx.moveTo(wheelX, wheelY + hubR);
    ctx.lineTo(wheelX, wheelY + rimInnerRadius);
    ctx.stroke();

    // 4. Crisp Tesla 'T' Logo inside Center Hub
    const tW = hubR * 0.7;
    const tH = hubR * 0.65;
    const tY = wheelY - tH * 0.35;

    ctx.beginPath();
    ctx.moveTo(wheelX - tW * 0.5, tY);
    ctx.quadraticCurveTo(wheelX, tY + tH * 0.15, wheelX + tW * 0.5, tY);
    ctx.moveTo(wheelX, tY + tH * 0.1);
    ctx.lineTo(wheelX, tY + tH);

    ctx.lineWidth = Math.max(1, size * 0.045);
    ctx.lineCap = 'round';
    ctx.strokeStyle = isActive ? '#FFFFFF' : '#1F2937';
    ctx.stroke();

    ctx.shadowBlur = 0;

    // 5. AP Status Text (Right side of steering wheel)
    const textX = wheelX + radius + size * 0.25;
    ctx.font = `400 ${size}px ${fontStack}`;
    ctx.textAlign = 'left';
    ctx.fillStyle = mainColor;
    const textCenterY = getVisualTextY(ctx, centerY, "0");

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

    ctx.fillText(displayLabel, textX, textCenterY);

    ctx.restore();
}

function drawTeslaBrake(ctx, x, centerY, size, isBrakeOn) {
    const pedalW = size * 1.05;
    const pedalH = size * 0.85;
    const pedalX = x;
    const pedalY = centerY - pedalH * 0.5;
    const pedalR = size * 0.12;

    ctx.save();

    if (isBrakeOn) {
        ctx.shadowColor = 'rgba(232, 33, 39, 0.5)';
        ctx.shadowBlur = size * 0.3;
    }

    // Tesla Brake Pedal Face Plate
    ctx.beginPath();
    drawRoundRect(ctx, pedalX, pedalY, pedalW, pedalH, pedalR);
    ctx.fillStyle = isBrakeOn ? '#E82127' : '#2D333B';
    ctx.fill();
    ctx.lineWidth = Math.max(1.2, size * 0.05);
    ctx.strokeStyle = isBrakeOn ? '#FF6B6B' : '#4B5563';
    ctx.stroke();

    // Anti-slip Rubber Grip Stripes (3 vertical bars)
    const gripW = pedalW * 0.14;
    const gripH = pedalH * 0.58;
    const gripY = centerY - gripH * 0.5;
    const gripR = gripW * 0.4;
    const gripGap = pedalW * 0.15;
    const startX = pedalX + (pedalW - (3 * gripW + 2 * gripGap)) * 0.5;

    ctx.fillStyle = isBrakeOn ? '#FFFFFF' : '#8A929B';
    for (let i = 0; i < 3; i++) {
        const gx = startX + i * (gripW + gripGap);
        ctx.beginPath();
        drawRoundRect(ctx, gx, gripY, gripW, gripH, gripR);
        ctx.fill();
    }

    ctx.restore();
}

function drawTeslaAccel(ctx, x, centerY, size, accelNum, fontStack) {
    const isValValid = typeof accelNum === 'number' && !isNaN(accelNum);
    const pct = isValValid ? Math.min(100, Math.max(0, accelNum)) : 0;
    const isAccelerating = pct > 0;

    const mainColor = isAccelerating ? '#10B981' : '#8A929B';

    ctx.save();

    // 1. Tesla Accelerator Pedal Icon
    const pedalW = size * 0.52;
    const pedalH = size * 0.85;
    const pedalX = x;
    const pedalY = centerY - pedalH * 0.5;
    const pedalR = size * 0.1;

    if (isAccelerating) {
        ctx.shadowColor = 'rgba(16, 185, 129, 0.4)';
        ctx.shadowBlur = size * 0.25;
    }

    ctx.beginPath();
    drawRoundRect(ctx, pedalX, pedalY, pedalW, pedalH, pedalR);
    ctx.fillStyle = isAccelerating ? '#064E3B' : '#2D333B';
    ctx.fill();
    ctx.lineWidth = Math.max(1.2, size * 0.05);
    ctx.strokeStyle = isAccelerating ? '#10B981' : '#4B5563';
    ctx.stroke();

    // Vertical Rubber Ribs (2 vertical bars)
    const ribW = pedalW * 0.16;
    const ribH = pedalH * 0.6;
    const ribY = centerY - ribH * 0.5;
    const ribGap = pedalW * 0.18;
    const ribStartX = pedalX + (pedalW - (2 * ribW + ribGap)) * 0.5;

    ctx.fillStyle = isAccelerating ? '#D1FAE5' : '#8A929B';
    for (let i = 0; i < 2; i++) {
        const rx = ribStartX + i * (ribW + ribGap);
        ctx.beginPath();
        drawRoundRect(ctx, rx, ribY, ribW, ribH, ribW * 0.4);
        ctx.fill();
    }

    if (isAccelerating) {
        ctx.shadowBlur = 0;
    }

    // 2. High-Tech Segmented Tesla Energy Bar
    const barX = pedalX + pedalW + size * 0.18;
    const barW = size * 1.5;
    const barH = size * 0.42;
    const barY = centerY - barH * 0.5;
    const numSegments = 8;
    const segGap = size * 0.04;
    const segW = (barW - (numSegments - 1) * segGap) / numSegments;
    const activeCount = Math.round((pct / 100) * numSegments);

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

    // 3. Percentage Readout
    const textX = barX + barW + size * 0.2;
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

    function pathLeftArrow(cx, cy) {
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + headW, cy - arrowH * 0.5);
        ctx.lineTo(cx + headW, cy - stemH * 0.5);
        ctx.lineTo(cx + arrowW, cy - stemH * 0.5);
        ctx.lineTo(cx + arrowW, cy + stemH * 0.5);
        ctx.lineTo(cx + headW, cy + stemH * 0.5);
        ctx.lineTo(cx + headW, cy + arrowH * 0.5);
        ctx.closePath();
    }

    function pathRightArrow(cx, cy) {
        ctx.beginPath();
        ctx.moveTo(cx + arrowW, cy);
        ctx.lineTo(cx + arrowW - headW, cy - arrowH * 0.5);
        ctx.lineTo(cx + arrowW - headW, cy - stemH * 0.5);
        ctx.lineTo(cx, cy - stemH * 0.5);
        ctx.lineTo(cx, cy + stemH * 0.5);
        ctx.lineTo(cx + arrowW - headW, cy + stemH * 0.5);
        ctx.lineTo(cx + arrowW - headW, cy + arrowH * 0.5);
        ctx.closePath();
    }

    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(1, size * 0.04);

    // Left Turn Signal Arrow
    if (activeLeft) {
        ctx.shadowColor = 'rgba(16, 185, 129, 0.8)';
        ctx.shadowBlur = size * 0.4;
        ctx.fillStyle = '#10B981';
        ctx.strokeStyle = '#34D399';
    } else {
        ctx.shadowBlur = 0;
        ctx.fillStyle = isLeftOn ? '#1F3A2B' : '#2D333B';
        ctx.strokeStyle = isLeftOn ? '#059669' : '#4B5563';
    }
    pathLeftArrow(x, centerY);
    ctx.fill();
    ctx.stroke();

    // Right Turn Signal Arrow
    const rightX = x + arrowW + gap;
    if (activeRight) {
        ctx.shadowColor = 'rgba(16, 185, 129, 0.8)';
        ctx.shadowBlur = size * 0.4;
        ctx.fillStyle = '#10B981';
        ctx.strokeStyle = '#34D399';
    } else {
        ctx.shadowBlur = 0;
        ctx.fillStyle = isLeftOn ? '#1F3A2B' : '#2D333B';
        ctx.strokeStyle = isRightOn ? '#059669' : '#4B5563';
    }
    pathRightArrow(rightX, centerY);
    ctx.fill();
    ctx.stroke();

    ctx.restore();
}

window.TelemetryRenderer = {
    getVisualTextY,
    drawRoundRect,
    drawTeslaAP,
    drawTeslaBrake,
    drawTeslaAccel,
    drawTeslaGear,
    drawTeslaBlinkers
};
