# Splash shown while the portable setup unpacks itself to %TEMP%.
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$logoPath = Join-Path $root 'renderer/assets/logo.png'
$out = Join-Path $root 'installer/splash.bmp'

$width = 420
$height = 240
$bmp = New-Object System.Drawing.Bitmap $width, $height, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
$rect = New-Object System.Drawing.Rectangle 0, 0, $width, $height
$brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect,
  ([System.Drawing.Color]::FromArgb(42, 36, 56)),
  ([System.Drawing.Color]::FromArgb(17, 15, 23)),
  90.0
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.FillRectangle($brush, $rect)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit

# The logo file has its own dark background, so it is drawn clipped to a
# rounded "app icon" tile instead of floating as a black square.
$logo = [System.Drawing.Image]::FromFile($logoPath)
$tileSize = 84
$tileX = [int](($width - $tileSize) / 2)
$tileY = 44
$tile = New-Object System.Drawing.Rectangle $tileX, $tileY, $tileSize, $tileSize
$radius = 22
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$d = $radius * 2
$path.AddArc($tileX, $tileY, $d, $d, 180, 90)
$path.AddArc($tileX + $tileSize - $d, $tileY, $d, $d, 270, 90)
$path.AddArc($tileX + $tileSize - $d, $tileY + $tileSize - $d, $d, $d, 0, 90)
$path.AddArc($tileX, $tileY + $tileSize - $d, $d, $d, 90, 90)
$path.CloseFigure()
$g.SetClip($path)
$g.DrawImage($logo, $tile)
$g.ResetClip()
$border = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(48, 255, 255, 255)), 1
$g.DrawPath($border, $path)

$white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(243, 242, 247))
$muted = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(163, 160, 176))
$accent = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(179, 160, 249))
$fontTitle = New-Object System.Drawing.Font 'Segoe UI', 17, ([System.Drawing.FontStyle]::Bold)
$fontSub = New-Object System.Drawing.Font 'Segoe UI', 9
$center = New-Object System.Drawing.StringFormat
$center.Alignment = [System.Drawing.StringAlignment]::Center

$g.DrawString('SallyLauncher', $fontTitle, $white, (New-Object System.Drawing.RectangleF 0, 136, $width, 30), $center)
# ASCII only: Windows PowerShell 5.1 reads this script as ANSI, which turned
# an ellipsis into "a-¦". Use ASCII text in the splash.
$g.DrawString('Setup wird vorbereitet ...', $fontSub, $muted, (New-Object System.Drawing.RectangleF 0, 170, $width, 18), $center)
$g.DrawString('SallyLabs', (New-Object System.Drawing.Font 'Segoe UI', 7.5), $accent, (New-Object System.Drawing.RectangleF 0, 208, $width, 16), $center)

$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Bmp)
$g.Dispose(); $bmp.Dispose(); $logo.Dispose(); $path.Dispose(); $border.Dispose()
$brush.Dispose(); $white.Dispose(); $muted.Dispose(); $accent.Dispose()
Write-Output "splash written: $out"
