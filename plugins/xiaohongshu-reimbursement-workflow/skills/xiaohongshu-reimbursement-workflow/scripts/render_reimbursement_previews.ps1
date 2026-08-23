param(
  [Parameter(Mandatory = $true)][string]$RequestPath,
  [Parameter(Mandatory = $true)][string]$RequestSha256,
  [Parameter(Mandatory = $true)][string]$RequestNonce
)

$ErrorActionPreference = "Stop"
$utf8NoBom = [Text.UTF8Encoding]::new($false, $true)
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom
$null = Add-Type -AssemblyName System.Drawing -ErrorAction SilentlyContinue
$MaxRequestBytes = 1MB
$AllowedProfiles = @("xiaohongshu", "company", "residence")
$AllowedRoles = @("root", "detail", "screenshot")

function Assert-ExactKeys {
  param([object]$Value, [string[]]$Keys, [string]$Field)
  if ($null -eq $Value -or $Value -isnot [pscustomobject]) { throw "$Field must be an object." }
  $actual = @($Value.PSObject.Properties.Name | Sort-Object)
  $expected = @($Keys | Sort-Object)
  if (($actual -join "`0") -ne ($expected -join "`0")) { throw "$Field has invalid fields." }
}

function Get-LowerSha256 {
  param([string]$Path)
  $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
  } finally {
    $algorithm.Dispose()
    $stream.Dispose()
  }
}

function Get-Utf8Sha256 {
  param([string]$Value)
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [Text.UTF8Encoding]::new($false, $true).GetBytes($Value)
    return ([BitConverter]::ToString($algorithm.ComputeHash($bytes))).Replace("-", "").ToLowerInvariant()
  } finally {
    $algorithm.Dispose()
  }
}

function Get-JobBindingDigest {
  param([object]$Job)
  $parts = @(
    "preview-job-binding-v2",
    [string]$Job.profileId,
    [string]$Job.role,
    [string]$Job.workbookSha256,
    [string]$Job.sheetName,
    [string]$Job.rangeAddress,
    [string]$Job.candidateSha256,
    [string]$Job.planSha256,
    [string]$Job.sourceCoverageDigest,
    (@($Job.batchRows) -join ",")
  )
  return Get-Utf8Sha256 ([string]::Join([char]0, $parts))
}

function Release-ComObject {
  param([object]$Value)
  if ($null -ne $Value) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($Value) }
}

if (-not ("CodexPreviewNativeMethods" -as [type])) {
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class CodexPreviewNativeMethods {
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")]
  public static extern uint GetClipboardSequenceNumber();
}
"@
}

function Start-ExcelEngine {
  $application = $null
  try {
    $application = New-Object -ComObject Excel.Application
    $application.Visible = $false
    $application.DisplayAlerts = $false
    $application.ScreenUpdating = $true
    [uint32]$enginePid = 0
    [void][CodexPreviewNativeMethods]::GetWindowThreadProcessId([IntPtr]$application.Hwnd, [ref]$enginePid)
    if ($enginePid -lt 1) { throw "Renderer could not bind the spreadsheet engine process." }
    return [pscustomobject]@{ Application = $application; Process = [Diagnostics.Process]::GetProcessById([int]$enginePid) }
  } catch {
    if ($null -ne $application) {
      try { $application.Quit() } catch {}
      Release-ComObject $application
    }
    throw
  }
}

function Stop-ExcelEngine {
  param([object]$Engine)
  if ($null -eq $Engine) { return }
  try { $Engine.Application.Quit() } catch {}
  Release-ComObject $Engine.Application
  if ($null -ne $Engine.Process) {
    try { [void]$Engine.Process.WaitForExit(5000) } catch {}
    $Engine.Process.Dispose()
  }
}

function Test-RenderedPng {
  param([string]$Path)
  $bytes = [IO.File]::ReadAllBytes($Path)
  if ($bytes.Length -lt 1000 -or $bytes[0] -ne 137 -or $bytes[1] -ne 80 -or $bytes[2] -ne 78 -or $bytes[3] -ne 71) { throw "Renderer did not create a valid non-empty PNG." }
  $stream = $null
  $source = $null
  $bitmap = $null
  try {
    $stream = [IO.MemoryStream]::new($bytes, $false)
    $source = [Drawing.Image]::FromStream($stream, $true, $true)
    $bitmap = [Drawing.Bitmap]::new($source)
    if ($bitmap.Width -lt 1 -or $bitmap.Height -lt 1 -or $bitmap.Width -gt 50000 -or $bitmap.Height -gt 50000) { throw "Renderer PNG dimensions are invalid." }
    $aspect = [double]$bitmap.Width / [double]$bitmap.Height
    if ($aspect -lt 0.01 -or $aspect -gt 100) { throw "Renderer PNG aspect ratio is unreasonable." }
    $colors = [Collections.Generic.HashSet[int]]::new()
    for ($x = 0; $x -lt 20; $x++) {
      for ($y = 0; $y -lt 20; $y++) {
        $pixelX = [Math]::Min($bitmap.Width - 1, [Math]::Floor(($x + 0.5) * $bitmap.Width / 20))
        $pixelY = [Math]::Min($bitmap.Height - 1, [Math]::Floor(($y + 0.5) * $bitmap.Height / 20))
        [void]$colors.Add($bitmap.GetPixel($pixelX, $pixelY).ToArgb())
      }
    }
    if ($colors.Count -lt 2) { throw "Renderer created a blank single-color PNG." }
    return [pscustomobject]@{ Size = $bytes.Length; Width = $bitmap.Width; Height = $bitmap.Height }
  } finally {
    if ($null -ne $bitmap) { $bitmap.Dispose() }
    if ($null -ne $source) { $source.Dispose() }
    if ($null -ne $stream) { $stream.Dispose() }
  }
}

function Render-PreviewJob {
  param([object]$Engine, [object]$Job, [string]$WorkbookPath, [string]$OutputPath, [string]$TemporaryPath, [int]$Attempt)
  $book = $null
  $sheet = $null
  $range = $null
  $charts = $null
  $chartObject = $null
  $chart = $null
  $step = "initialize"
  try {
    $step = "open-workbook"
    $book = $Engine.Application.Workbooks.Open($WorkbookPath, 0, $true)
    $step = "activate-workbook"
    [void]$book.Activate()
    $step = "select-sheet"
    $sheet = $book.Worksheets.Item([string]$Job.sheetName)
    $step = "activate-sheet"
    [void]$sheet.Activate()
    $step = "select-range"
    $range = $sheet.Range([string]$Job.rangeAddress)
    $step = "goto-range"
    [void]$Engine.Application.Goto($range, $true)
    $clipboardBefore = [CodexPreviewNativeMethods]::GetClipboardSequenceNumber()
    $step = "copy-picture"
    [void]$range.CopyPicture(1, 2)
    $step = "await-fresh-clipboard"
    $clipboardChanged = $false
    for ($poll = 0; $poll -lt 100; $poll++) {
      if ([CodexPreviewNativeMethods]::GetClipboardSequenceNumber() -ne $clipboardBefore) { $clipboardChanged = $true; break }
      [Threading.Thread]::Sleep(15)
    }
    if (-not $clipboardChanged) { throw "Excel did not publish a fresh range image to the clipboard." }
    $step = "create-chart"
    $charts = $sheet.ChartObjects()
    $chartObject = $charts.Add(0, 0, [Math]::Max(1.0, [double]$range.Width), [Math]::Max(1.0, [double]$range.Height))
    $chart = $chartObject.Chart
    $step = "paste-picture"
    [void]$chart.Paste()
    $step = "export-png"
    $exportResult = $chart.Export($TemporaryPath, "PNG")
    $exportReady = $false
    $png = $null
    for ($poll = 0; $poll -lt 100; $poll++) {
      if (Test-Path -LiteralPath $TemporaryPath) {
        $temporaryInfo = Get-Item -LiteralPath $TemporaryPath -Force
        if (-not $temporaryInfo.PSIsContainer -and $temporaryInfo.Length -ge 1000) {
          try { $png = Test-RenderedPng $TemporaryPath; $exportReady = $true; break } catch {}
        }
      }
      [Threading.Thread]::Sleep(15)
    }
    if (-not $exportReady) { throw "Excel chart export did not produce a stable PNG (return value: $exportResult)." }
    $step = "hash-png"
    $renderSha256 = Get-LowerSha256 $TemporaryPath
    $step = "commit-png"
    [IO.File]::Move($TemporaryPath, $OutputPath)
    return [pscustomobject]@{
      profileId = [string]$Job.profileId; role = [string]$Job.role; workbookSha256 = [string]$Job.workbookSha256
      sheetName = [string]$Job.sheetName; rangeAddress = [string]$Job.rangeAddress
      candidateSha256 = [string]$Job.candidateSha256; planSha256 = [string]$Job.planSha256
      sourceCoverageDigest = [string]$Job.sourceCoverageDigest; batchRows = @($Job.batchRows)
      bindingDigest = [string]$Job.bindingDigest; outputPath = $OutputPath
      sha256 = $renderSha256; size = [int64]$png.Size; renderAttempts = $Attempt
    }
  } catch {
    throw "Preview render step '$step' failed: $($_.Exception.Message)"
  } finally {
    Release-ComObject $chart
    if ($null -ne $chartObject) { try { [void]$chartObject.Delete() } catch {} }
    Release-ComObject $chartObject
    Release-ComObject $charts
    Release-ComObject $range
    Release-ComObject $sheet
    if ($null -ne $book) { try { $book.Close($false) } catch {} }
    Release-ComObject $book
    if (Test-Path -LiteralPath $TemporaryPath) { Remove-Item -LiteralPath $TemporaryPath -Force }
  }
}

if ([Threading.Thread]::CurrentThread.GetApartmentState() -ne [Threading.ApartmentState]::STA) { throw "Preview renderer requires an STA PowerShell process." }
$resolvedRequest = [IO.Path]::GetFullPath($RequestPath)
if ($RequestSha256 -cnotmatch '^[0-9a-f]{64}$' -or $RequestNonce -cnotmatch '^[0-9a-f]{64}$') { throw "Renderer request binding is invalid." }
$requestInfo = Get-Item -LiteralPath $resolvedRequest -Force
if (-not $requestInfo.PSIsContainer -and $requestInfo.Length -gt 0 -and $requestInfo.Length -le $MaxRequestBytes) { $requestBytes = [IO.File]::ReadAllBytes($resolvedRequest) } else { throw "Renderer request must be a bounded regular file." }
if ((Get-LowerSha256 $resolvedRequest) -cne $RequestSha256) { throw "Renderer request SHA-256 differs from the parent binding." }
$utf8 = [Text.UTF8Encoding]::new($false, $true)
$request = $utf8.GetString($requestBytes) | ConvertFrom-Json
Assert-ExactKeys $request @("kind", "requestNonce", "outputRoot", "bindingDigest", "bindings", "jobs") "request"
if ($request.kind -cne "ordinary-reimbursement-preview-request-v2" -or $request.requestNonce -cne $RequestNonce -or [string]$request.bindingDigest -cnotmatch '^[0-9a-f]{64}$') { throw "Renderer request identity differs from the parent binding." }
if ($request.jobs -isnot [array] -or $request.jobs.Count -lt 3 -or $request.jobs.Count -gt 9 -or ($request.jobs.Count % 3) -ne 0) { throw "Renderer request must contain one to three complete profile preview sets." }
if ($request.bindings -isnot [array] -or $request.bindings.Count -ne ($request.jobs.Count / 3)) { throw "Renderer request bindings do not match its profile sets." }
$bindingByProfile = @{}
foreach ($binding in $request.bindings) {
  Assert-ExactKeys $binding @("profileId", "candidateSha256", "planSha256", "sourceCoverageDigest", "batchRows", "rootPreviewRange") "render binding"
  if ($AllowedProfiles -cnotcontains [string]$binding.profileId -or $bindingByProfile.ContainsKey([string]$binding.profileId)) { throw "Render binding profile is invalid or duplicated." }
  foreach ($digest in @($binding.candidateSha256, $binding.planSha256, $binding.sourceCoverageDigest)) { if ([string]$digest -cnotmatch '^[0-9a-f]{64}$') { throw "Render binding digest is invalid." } }
  if ([string]$binding.rootPreviewRange -cnotmatch '^[A-Z]{1,3}[1-9][0-9]*:[A-Z]{1,3}[1-9][0-9]*$' -or $binding.batchRows -isnot [array] -or $binding.batchRows.Count -lt 1) { throw "Render binding range is invalid." }
  foreach ($rowRange in $binding.batchRows) { if ([string]$rowRange -cnotmatch '^[1-9][0-9]*:[1-9][0-9]*$') { throw "Render binding batch row range is invalid." } }
  $bindingByProfile[[string]$binding.profileId] = $binding
}
$outputRoot = [IO.Path]::GetFullPath([string]$request.outputRoot)
$outputRootInfo = Get-Item -LiteralPath $outputRoot -Force
if (-not $outputRootInfo.PSIsContainer -or ($outputRootInfo.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Renderer outputRoot must be a plain directory." }

$seenOutputs = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$created = [Collections.Generic.List[object]]::new()
$engine = $null
$enginePeakWorkingSetBytes = 0L
try {
  $engine = Start-ExcelEngine
  foreach ($job in $request.jobs) {
    Assert-ExactKeys $job @("profileId", "role", "workbookPath", "workbookSha256", "sheetName", "rangeAddress", "outputPath", "candidateSha256", "planSha256", "sourceCoverageDigest", "batchRows", "bindingDigest") "render job"
    if ($AllowedProfiles -cnotcontains [string]$job.profileId -or $AllowedRoles -cnotcontains [string]$job.role) { throw "Render job profile or role is invalid." }
    foreach ($digest in @($job.workbookSha256, $job.candidateSha256, $job.planSha256, $job.sourceCoverageDigest, $job.bindingDigest)) { if ([string]$digest -cnotmatch '^[0-9a-f]{64}$') { throw "Render job digest is invalid." } }
    if ([string]$job.rangeAddress -cnotmatch '^[A-Z]{1,3}[1-9][0-9]*:[A-Z]{1,3}[1-9][0-9]*$' -or $job.batchRows -isnot [array] -or $job.batchRows.Count -lt 1) { throw "Render job range binding is invalid." }
    $binding = $bindingByProfile[[string]$job.profileId]
    if ($null -eq $binding -or [string]$job.candidateSha256 -cne [string]$binding.candidateSha256 -or [string]$job.planSha256 -cne [string]$binding.planSha256 -or [string]$job.sourceCoverageDigest -cne [string]$binding.sourceCoverageDigest -or (@($job.batchRows) -join "`0") -cne (@($binding.batchRows) -join "`0") -or ([string]$job.role -ceq "root" -and [string]$job.rangeAddress -cne [string]$binding.rootPreviewRange) -or (Get-JobBindingDigest $job) -cne [string]$job.bindingDigest) { throw "Render job is not covered by its complete current candidate binding." }
    $workbookPath = [IO.Path]::GetFullPath([string]$job.workbookPath)
    $outputPath = [IO.Path]::GetFullPath([string]$job.outputPath)
    if (-not [StringComparer]::OrdinalIgnoreCase.Equals([IO.Path]::GetDirectoryName($outputPath), $outputRoot) -or -not $seenOutputs.Add($outputPath)) { throw "Render output path is outside outputRoot or duplicated." }
    if (Test-Path -LiteralPath $outputPath) { throw "Render output path already exists." }
    if ((Get-LowerSha256 $workbookPath) -cne [string]$job.workbookSha256) { throw "Render source changed before open." }
    $rendered = $null
    $lastError = $null
    for ($attempt = 1; $attempt -le 3; $attempt++) {
      # Excel Chart.Export still uses a legacy path limit on some Office builds.
      # outputRoot is request-bound and private to this stage, so a short nonce
      # prefix remains collision-safe while keeping the export path well below it.
      $temporaryPath = Join-Path $outputRoot ".codex-preview-$($RequestNonce.Substring(0, 16))-$($job.profileId)-$($job.role)-$attempt.partial.png"
      try {
        if ($attempt -gt 1) { Stop-ExcelEngine $engine; $engine = $null; $engine = Start-ExcelEngine }
        $rendered = Render-PreviewJob $engine $job $workbookPath $outputPath $temporaryPath $attempt
        break
      } catch {
        $lastError = $_.Exception
        if (Test-Path -LiteralPath $outputPath) { Remove-Item -LiteralPath $outputPath -Force }
        if (Test-Path -LiteralPath $temporaryPath) { Remove-Item -LiteralPath $temporaryPath -Force }
      } finally {
        try { $engine.Process.Refresh(); $enginePeakWorkingSetBytes = [Math]::Max($enginePeakWorkingSetBytes, [int64]$engine.Process.PeakWorkingSet64) } catch {}
      }
    }
    if ($null -eq $rendered) { throw "Preview $($job.profileId)/$($job.role) failed after 3 attempts: $($lastError.Message)" }
    if ((Get-LowerSha256 $workbookPath) -cne [string]$job.workbookSha256) { throw "Render source changed during render." }
    $created.Add($rendered)
  }
} finally {
  Stop-ExcelEngine $engine
}

if ((Get-LowerSha256 $resolvedRequest) -cne $RequestSha256) { throw "Renderer request changed during execution." }
$response = [ordered]@{
  kind = "ordinary-reimbursement-preview-response-v2"
  requestNonce = $RequestNonce
  requestFileSha256 = $RequestSha256
  bindingDigest = [string]$request.bindingDigest
  enginePeakWorkingSetBytes = [Math]::Max(1L, $enginePeakWorkingSetBytes)
  previews = @($created)
}
[Console]::Out.WriteLine(($response | ConvertTo-Json -Compress -Depth 6))
