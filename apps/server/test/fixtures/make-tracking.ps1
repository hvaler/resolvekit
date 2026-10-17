# Renders tracking.png: synthetic data only, black Arial text on white (Windows, System.Drawing).
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap 1520, 480
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::White)
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$font = New-Object System.Drawing.Font 'Arial', 52, ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)
$lines = 'UPS Tracking 1Z999AA10123456784', 'Delivered 8 Oct 2026 11:52', 'Signed J. D.'
$y = 60
foreach ($l in $lines) { $g.DrawString($l, $font, [System.Drawing.Brushes]::Black, 60, $y); $y += 120 }
$bmp.Save((Join-Path $PSScriptRoot 'tracking.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
