param(
  [Parameter(Mandatory = $true)][string]$RequestPath,
  [Parameter(Mandatory = $true)][string]$RequestSha256,
  [Parameter(Mandatory = $true)][string]$RequestNonce
)

$ErrorActionPreference = "Stop"
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
}
"@
}

$resolvedRequest = [IO.Path]::GetFullPath($RequestPath)
if ($RequestSha256 -cnotmatch '^[0-9a-f]{64}$' -or $RequestNonce -cnotmatch '^[0-9a-f]{64}$') {
  throw "Renderer request binding is invalid."
}
$requestInfo = Get-Item -LiteralPath $resolvedRequest -Force
if (-not $requestInfo.PSIsContainer -and $requestInfo.Length -gt 0 -and $requestInfo.Length -le $MaxRequestBytes) {
  $requestBytes = [IO.File]::ReadAllBytes($resolvedRequest)
} else {
  throw "Renderer request must be a bounded regular file."
}
if ((Get-LowerSha256 $resolvedRequest) -cne $RequestSha256) { throw "Renderer request SHA-256 differs from the parent binding." }
$utf8 = [Text.UTF8Encoding]::new($false, $true)
$request = $utf8.GetString($requestBytes) | ConvertFrom-Json
Assert-ExactKeys $request @("kind", "requestNonce", "outputRoot", "bindings", "jobs") "request"
if ($request.kind -cne "ordinary-reimbursement-preview-request-v1" -or $request.requestNonce -cne $RequestNonce) {
  throw "Renderer request identity differs from the parent binding."
}
if ($request.jobs -isnot [array] -or $request.jobs.Count -lt 3 -or $request.jobs.Count -gt 9 -or ($request.jobs.Count % 3) -ne 0) {
  throw "Renderer request must contain one to three complete profile preview sets."
}
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
if (-not $outputRootInfo.PSIsContainer -or ($outputRootInfo.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
  throw "Renderer outputRoot must be a plain directory."
}

$seenOutputs = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$created = [Collections.Generic.List[object]]::new()
$excel = $null
$engineProcess = $null
$enginePeakWorkingSetBytes = 0L
try {
  $excel = New-Object -ComObject Excel.Application
  $excel.Visible = $false
  $excel.DisplayAlerts = $false
  [uint32]$enginePid = 0
  [void][CodexPreviewNativeMethods]::GetWindowThreadProcessId([IntPtr]$excel.Hwnd, [ref]$enginePid)
  if ($enginePid -lt 1) { throw "Renderer could not bind the spreadsheet engine process." }
  $engineProcess = [Diagnostics.Process]::GetProcessById([int]$enginePid)
  foreach ($job in $request.jobs) {
    Assert-ExactKeys $job @("profileId", "role", "workbookPath", "workbookSha256", "sheetName", "rangeAddress", "outputPath") "render job"
    if ($AllowedProfiles -cnotcontains [string]$job.profileId -or $AllowedRoles -cnotcontains [string]$job.role) { throw "Render job profile or role is invalid." }
    if ([string]$job.workbookSha256 -cnotmatch '^[0-9a-f]{64}$' -or [string]$job.rangeAddress -cnotmatch '^[A-Z]{1,3}[1-9][0-9]*:[A-Z]{1,3}[1-9][0-9]*$') {
      throw "Render job hash or range is invalid."
    }
    $binding = $bindingByProfile[[string]$job.profileId]
    if ($null -eq $binding -or ([string]$job.role -ceq "root" -and [string]$job.rangeAddress -cne [string]$binding.rootPreviewRange)) { throw "Render job is not covered by its current candidate binding." }
    $workbookPath = [IO.Path]::GetFullPath([string]$job.workbookPath)
    $outputPath = [IO.Path]::GetFullPath([string]$job.outputPath)
    if ([IO.Path]::GetDirectoryName($outputPath) -cne $outputRoot -or -not $seenOutputs.Add($outputPath)) { throw "Render output path is outside outputRoot or duplicated." }
    if (Test-Path -LiteralPath $outputPath) { throw "Render output path already exists." }
    if ((Get-LowerSha256 $workbookPath) -cne [string]$job.workbookSha256) { throw "Render source changed before open." }
    $book = $null
    $sheet = $null
    $range = $null
    $charts = $null
    $chartObject = $null
    $chart = $null
    try {
      $book = $excel.Workbooks.Open($workbookPath, 0, $true)
      $sheet = $book.Worksheets.Item([string]$job.sheetName)
      $range = $sheet.Range([string]$job.rangeAddress)
      [void]$range.CopyPicture(1, 2)
      $charts = $sheet.ChartObjects()
      $chartObject = $charts.Add(0, 0, [double]$range.Width, [double]$range.Height)
      $chart = $chartObject.Chart
      [void]$chart.Paste()
      [void]$chart.Export($outputPath, "PNG")
    } finally {
      Release-ComObject $chart
      if ($null -ne $chartObject) { [void]$chartObject.Delete() }
      Release-ComObject $chartObject
      Release-ComObject $charts
      Release-ComObject $range
      Release-ComObject $sheet
      if ($null -ne $book) { $book.Close($false) }
      Release-ComObject $book
    }
    if ((Get-LowerSha256 $workbookPath) -cne [string]$job.workbookSha256) { throw "Render source changed during render." }
    $outputBytes = [IO.File]::ReadAllBytes($outputPath)
    if ($outputBytes.Length -lt 1000 -or $outputBytes[0] -ne 137 -or $outputBytes[1] -ne 80 -or $outputBytes[2] -ne 78 -or $outputBytes[3] -ne 71) {
      throw "Renderer did not create a valid non-empty PNG."
    }
    $bitmap = $null
    try {
      $bitmap = [Drawing.Bitmap]::FromFile($outputPath)
      if ($bitmap.Width -lt 1 -or $bitmap.Height -lt 1) { throw "Renderer PNG dimensions are invalid." }
      $colors = [Collections.Generic.HashSet[int]]::new()
      for ($x = 0; $x -lt 20; $x++) {
        for ($y = 0; $y -lt 20; $y++) {
          $pixelX = [Math]::Min($bitmap.Width - 1, [Math]::Floor(($x + 0.5) * $bitmap.Width / 20))
          $pixelY = [Math]::Min($bitmap.Height - 1, [Math]::Floor(($y + 0.5) * $bitmap.Height / 20))
          [void]$colors.Add($bitmap.GetPixel($pixelX, $pixelY).ToArgb())
        }
      }
      if ($colors.Count -lt 2) { throw "Renderer created a blank single-color PNG." }
    } finally {
      if ($null -ne $bitmap) { $bitmap.Dispose() }
    }
    $created.Add([pscustomobject]@{
      profileId = [string]$job.profileId
      role = [string]$job.role
      workbookSha256 = [string]$job.workbookSha256
      outputPath = $outputPath
      sha256 = Get-LowerSha256 $outputPath
      size = $outputBytes.Length
    })
    $engineProcess.Refresh()
    $enginePeakWorkingSetBytes = [Math]::Max($enginePeakWorkingSetBytes, [int64]$engineProcess.PeakWorkingSet64)
  }
} finally {
  if ($null -ne $excel) { $excel.Quit() }
  Release-ComObject $excel
}

if ((Get-LowerSha256 $resolvedRequest) -cne $RequestSha256) { throw "Renderer request changed during execution." }
$response = [ordered]@{
  kind = "ordinary-reimbursement-preview-response-v1"
  requestNonce = $RequestNonce
  requestFileSha256 = $RequestSha256
  enginePeakWorkingSetBytes = $enginePeakWorkingSetBytes
  previews = @($created)
}
[Console]::Out.WriteLine(($response | ConvertTo-Json -Compress -Depth 5))
