param(
    [Parameter(Mandatory = $true)][string]$BaselinePath,
    [Parameter(Mandatory = $true)][string]$CandidatePath,
    [Parameter(Mandatory = $true)][string]$TargetPath,
    [Parameter(Mandatory = $true)][string]$ExpectedBaselineSha256,
    [Parameter(Mandatory = $true)][string]$ExpectedCandidateSha256,
    [Parameter(DontShow = $true)][ValidateRange(0, 60000)][int]$InternalTestPauseAfterMutationMilliseconds = 0,
    [Parameter(DontShow = $true)][ValidateSet("", "lock_pending", "journal_pending", "lock_partial", "journal_partial")][string]$InternalTestPauseAfterMetadataPhase = "",
    [Parameter(DontShow = $true)][ValidateRange(0, 60000)][int]$InternalTestPauseAfterMetadataMilliseconds = 0,
    [Parameter(DontShow = $true)][ValidateRange(0, 60000)][int]$InternalTestPauseDuringTempCopyMilliseconds = 0,
    [Parameter(DontShow = $true)][switch]$RecoveryOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$LockKind = "codex-xhs-publish-lock"
$JournalKind = "codex-xhs-publish-journal"
$ProtocolVersion = 2
$TerminalPhases = @("cleanup_complete", "rolled_back")
$JournalPhases = @(
    "initial",
    "replace_armed",
    "replace_committed",
    "create_armed",
    "create_committed",
    "verified",
    "cleanup_complete",
    "rolled_back"
)

function Normalize-Hash([string]$Value) {
    $normalized = $Value.Trim().ToUpperInvariant()
    if ($normalized -notmatch "^[0-9A-F]{64}$") {
        throw "Expected SHA256 must contain exactly 64 hexadecimal characters."
    }
    return $normalized
}

function Test-SamePath([string]$Left, [string]$Right) {
    return [string]::Equals(
        [System.IO.Path]::GetFullPath($Left),
        [System.IO.Path]::GetFullPath($Right),
        [System.StringComparison]::OrdinalIgnoreCase
    )
}

function Test-DirectChild([string]$Path, [string]$Directory) {
    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $fullDirectory = [System.IO.Path]::GetFullPath($Directory)
    return Test-SamePath ([System.IO.Path]::GetDirectoryName($fullPath)) $fullDirectory
}

function Assert-DirectChild([string]$Path, [string]$Directory, [string]$Label) {
    if (-not (Test-DirectChild $Path $Directory)) {
        throw "$Label must be a direct child of the bound target directory."
    }
}

function Get-ExactEntry([string]$Path) {
    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $directory = [System.IO.Path]::GetDirectoryName($fullPath)
    if (-not [System.IO.Directory]::Exists($directory)) {
        return $null
    }
    $name = [System.IO.Path]::GetFileName($fullPath)
    foreach ($entry in [System.IO.Directory]::EnumerateFileSystemEntries($directory)) {
        if ([string]::Equals([System.IO.Path]::GetFileName($entry), $name, [System.StringComparison]::OrdinalIgnoreCase)) {
            return $entry
        }
    }
    return $null
}

function Test-EntryExists([string]$Path) {
    return $null -ne (Get-ExactEntry $Path)
}

function Assert-EntryAbsent([string]$Path, [string]$Label) {
    if (Test-EntryExists $Path) {
        throw "$Label already exists and was preserved."
    }
}

function Assert-RegularUnlinkedFile([string]$Path, [string]$Label) {
    $entry = Get-ExactEntry $Path
    if ($null -eq $entry) {
        throw "$Label does not exist."
    }
    $item = Get-Item -LiteralPath $entry -Force -ErrorAction Stop
    if ($item.PSIsContainer) {
        throw "$Label must be a regular file, not a directory."
    }
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "$Label must not be a symbolic link, junction, or other reparse point."
    }
    $linkTypeProperty = $item.PSObject.Properties["LinkType"]
    if ($null -ne $linkTypeProperty -and -not [string]::IsNullOrWhiteSpace([string]$linkTypeProperty.Value)) {
        throw "$Label must not be a hard link or other linked file."
    }
    return [System.IO.Path]::GetFullPath($entry)
}

function Get-StreamSha256([System.IO.Stream]$Stream) {
    $originalPosition = $Stream.Position
    try {
        $Stream.Position = 0
        $sha = [System.Security.Cryptography.SHA256]::Create()
        try {
            $bytes = $sha.ComputeHash($Stream)
            return ([System.BitConverter]::ToString($bytes)).Replace("-", "")
        }
        finally {
            $sha.Dispose()
        }
    }
    finally {
        $Stream.Position = $originalPosition
    }
}

function Get-BytesSha256([byte[]]$Bytes) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        return ([System.BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace("-", "")
    }
    finally {
        $sha.Dispose()
    }
}

function Get-TextSha256([string]$Value) {
    return Get-BytesSha256 ([System.Text.Encoding]::UTF8.GetBytes($Value))
}

function Get-PathSha256([string]$Path, [string]$Label = "File") {
    $regularPath = Assert-RegularUnlinkedFile $Path $Label
    $stream = [System.IO.File]::Open(
        $regularPath,
        [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::Read,
        [System.IO.FileShare]::Read
    )
    try {
        return Get-StreamSha256 $stream
    }
    finally {
        $stream.Dispose()
    }
}

function ConvertTo-AsciiJson([object]$Value) {
    $json = $Value | ConvertTo-Json -Compress -Depth 8
    $builder = New-Object System.Text.StringBuilder
    foreach ($character in $json.ToCharArray()) {
        $code = [int][char]$character
        if ($code -gt 127) {
            [void]$builder.Append(("\u{0:X4}" -f $code))
        }
        else {
            [void]$builder.Append($character)
        }
    }
    return $builder.ToString()
}

function Write-JsonToStream([System.IO.FileStream]$Stream, [object]$Value) {
    $json = ConvertTo-AsciiJson $Value
    $bytes = [System.Text.Encoding]::ASCII.GetBytes($json)
    if ($bytes.Length -gt 65536) {
        throw "Publish ownership metadata exceeded the bounded size."
    }
    $Stream.Position = 0
    $Stream.SetLength(0)
    $Stream.Write($bytes, 0, $bytes.Length)
    $Stream.Flush($true)
    return Get-BytesSha256 $bytes
}

function Read-JsonFromStream([System.IO.FileStream]$Stream, [string]$Label) {
    if ($Stream.Length -le 0 -or $Stream.Length -gt 65536) {
        throw "$Label has an invalid bounded length."
    }
    $Stream.Position = 0
    $reader = New-Object System.IO.StreamReader(
        $Stream,
        [System.Text.Encoding]::ASCII,
        $false,
        4096,
        $true
    )
    try {
        $text = $reader.ReadToEnd()
    }
    finally {
        $reader.Dispose()
    }
    try {
        return $text | ConvertFrom-Json -ErrorAction Stop
    }
    catch {
        throw "$Label is not valid JSON and was preserved."
    }
}

function Assert-ExactProperties([object]$Value, [string[]]$Expected, [string]$Label) {
    if ($null -eq $Value -or $Value -isnot [psobject]) {
        throw "$Label must be a JSON object."
    }
    $actual = @($Value.PSObject.Properties | ForEach-Object { $_.Name })
    if ($actual.Count -ne $Expected.Count) {
        throw "$Label has an unexpected property set and was preserved."
    }
    foreach ($name in $Expected) {
        if ($actual -notcontains $name) {
            throw "$Label is missing property $name and was preserved."
        }
    }
}

function Assert-RecordedPath([object]$Value, [string]$Expected, [string]$Label) {
    if ($Value -isnot [string] -or -not [System.IO.Path]::IsPathRooted([string]$Value) -or -not (Test-SamePath ([string]$Value) $Expected)) {
        throw "$Label does not match the current publish invocation and was preserved."
    }
}

function Get-InvocationDigest(
    [string]$Baseline,
    [string]$Candidate,
    [string]$Target,
    [string]$BaselineHash,
    [string]$CandidateHash
) {
    $canonical = @(
        "codex-xhs-safe-publish-v2",
        ([System.IO.Path]::GetFullPath($Baseline).ToLowerInvariant()),
        ([System.IO.Path]::GetFullPath($Candidate).ToLowerInvariant()),
        ([System.IO.Path]::GetFullPath($Target).ToLowerInvariant()),
        $BaselineHash.ToUpperInvariant(),
        $CandidateHash.ToUpperInvariant()
    ) -join "`n"
    return Get-TextSha256 $canonical
}

function Get-CurrentProcessStartTicks() {
    return ([System.Diagnostics.Process]::GetCurrentProcess().StartTime.ToUniversalTime().Ticks)
}

function Test-RecordedProcessAlive([int]$ProcessId, [long]$StartTicks) {
    $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if ($null -eq $process) {
        return $false
    }
    try {
        return $process.StartTime.ToUniversalTime().Ticks -eq $StartTicks
    }
    catch {
        throw "Could not verify the recorded lock owner process; recovery is fail-closed."
    }
}

function New-LockRecord(
    [string]$Owner,
    [int]$ProcessId,
    [long]$StartTicks,
    [string]$InvocationDigest,
    [string]$Baseline,
    [string]$Candidate,
    [string]$Target,
    [string]$BaselineHash,
    [string]$CandidateHash,
    [string]$Journal
) {
    return [pscustomobject][ordered]@{
        kind = $LockKind
        version = $ProtocolVersion
        owner = $Owner
        pid = $ProcessId
        processStartUtcTicks = $StartTicks
        createdUtc = [DateTime]::UtcNow.ToString("o")
        invocationDigest = $InvocationDigest
        baselinePath = $Baseline
        candidatePath = $Candidate
        targetPath = $Target
        expectedBaselineSha256 = $BaselineHash
        expectedCandidateSha256 = $CandidateHash
        journalPath = $Journal
    }
}

function New-JournalRecord(
    [object]$LockRecord,
    [bool]$TargetExisted,
    [string]$Temp,
    [AllowNull()][object]$Backup,
    [string]$Phase
) {
    return [pscustomobject][ordered]@{
        kind = $JournalKind
        version = $ProtocolVersion
        owner = $LockRecord.owner
        pid = $LockRecord.pid
        processStartUtcTicks = $LockRecord.processStartUtcTicks
        invocationDigest = $LockRecord.invocationDigest
        baselinePath = $LockRecord.baselinePath
        candidatePath = $LockRecord.candidatePath
        targetPath = $LockRecord.targetPath
        expectedBaselineSha256 = $LockRecord.expectedBaselineSha256
        expectedCandidateSha256 = $LockRecord.expectedCandidateSha256
        targetExisted = $TargetExisted
        tempPath = $Temp
        backupPath = if ($null -eq $Backup) { $null } else { [string]$Backup }
        phase = $Phase
        updatedUtc = [DateTime]::UtcNow.ToString("o")
    }
}

$LockProperties = @(
    "kind", "version", "owner", "pid", "processStartUtcTicks", "createdUtc", "invocationDigest",
    "baselinePath", "candidatePath", "targetPath", "expectedBaselineSha256",
    "expectedCandidateSha256", "journalPath"
)
$JournalProperties = @(
    "kind", "version", "owner", "pid", "processStartUtcTicks", "invocationDigest",
    "baselinePath", "candidatePath", "targetPath", "expectedBaselineSha256",
    "expectedCandidateSha256", "targetExisted", "tempPath", "backupPath", "phase", "updatedUtc"
)

function Assert-LockRecord(
    [object]$Record,
    [string]$ExpectedInvocationDigest,
    [string]$Baseline,
    [string]$Candidate,
    [string]$Target,
    [string]$ExpectedBaseline,
    [string]$ExpectedCandidate,
    [string]$TargetDirectory
) {
    Assert-ExactProperties $Record $LockProperties "Publish lock"
    if ($Record.kind -ne $LockKind -or [int]$Record.version -ne $ProtocolVersion) {
        throw "Publish lock protocol is not recognized and was preserved."
    }
    if ($Record.owner -isnot [string] -or [string]$Record.owner -notmatch "^[0-9a-f]{32}$") {
        throw "Publish lock owner token is invalid and was preserved."
    }
    if ([int64]$Record.pid -le 0 -or [int64]$Record.pid -gt [int]::MaxValue -or [int64]$Record.processStartUtcTicks -le 0) {
        throw "Publish lock process identity is invalid and was preserved."
    }
    if ($Record.invocationDigest -ne $ExpectedInvocationDigest) {
        throw "Stale publish lock belongs to a different invocation and was preserved."
    }
    Assert-RecordedPath $Record.baselinePath $Baseline "Publish lock baselinePath"
    Assert-RecordedPath $Record.candidatePath $Candidate "Publish lock candidatePath"
    Assert-RecordedPath $Record.targetPath $Target "Publish lock targetPath"
    if ($Record.expectedBaselineSha256 -ne $ExpectedBaseline -or $Record.expectedCandidateSha256 -ne $ExpectedCandidate) {
        throw "Publish lock hashes do not match the current invocation and were preserved."
    }
    $expectedJournal = [System.IO.Path]::Combine($TargetDirectory, ".codex-xhs-publish-$($Record.owner).journal")
    Assert-RecordedPath $Record.journalPath $expectedJournal "Publish lock journalPath"
    Assert-DirectChild ([string]$Record.journalPath) $TargetDirectory "Publish lock journalPath"
}

function Assert-JournalRecord(
    [object]$Record,
    [object]$LockRecord,
    [string]$TargetDirectory
) {
    Assert-ExactProperties $Record $JournalProperties "Publish journal"
    if ($Record.kind -ne $JournalKind -or [int]$Record.version -ne $ProtocolVersion) {
        throw "Publish journal protocol is not recognized and was preserved."
    }
    foreach ($field in @("owner", "pid", "processStartUtcTicks", "invocationDigest", "expectedBaselineSha256", "expectedCandidateSha256")) {
        if ([string]$Record.$field -ne [string]$LockRecord.$field) {
            throw "Publish journal $field does not match its lock and was preserved."
        }
    }
    Assert-RecordedPath $Record.baselinePath ([string]$LockRecord.baselinePath) "Publish journal baselinePath"
    Assert-RecordedPath $Record.candidatePath ([string]$LockRecord.candidatePath) "Publish journal candidatePath"
    Assert-RecordedPath $Record.targetPath ([string]$LockRecord.targetPath) "Publish journal targetPath"
    if ($Record.targetExisted -isnot [bool]) {
        throw "Publish journal targetExisted must be a boolean."
    }
    if ($Record.phase -isnot [string] -or $JournalPhases -notcontains [string]$Record.phase) {
        throw "Publish journal phase is invalid and was preserved."
    }
    $expectedTemp = [System.IO.Path]::Combine($TargetDirectory, ".codex-xhs-publish-$($Record.owner).tmp")
    Assert-RecordedPath $Record.tempPath $expectedTemp "Publish journal tempPath"
    Assert-DirectChild ([string]$Record.tempPath) $TargetDirectory "Publish journal tempPath"
    $expectedBackup = [System.IO.Path]::Combine($TargetDirectory, ".codex-xhs-backup-$($Record.owner).tmp")
    if ([bool]$Record.targetExisted) {
        Assert-RecordedPath $Record.backupPath $expectedBackup "Publish journal backupPath"
        Assert-DirectChild ([string]$Record.backupPath) $TargetDirectory "Publish journal backupPath"
    }
    elseif ($null -ne $Record.backupPath) {
        throw "Publish journal for a new target must not bind a backup path."
    }
}

function New-JournalFile([string]$Path, [object]$Record) {
    return New-AtomicJsonFile $Path $Record "journal_pending"
}

function Update-JournalFile([string]$Path, [object]$Record, [string]$Phase) {
    if ($JournalPhases -notcontains $Phase) {
        throw "Internal publish journal phase is invalid."
    }
    [void](Assert-RegularUnlinkedFile $Path "Publish journal")
    $diskHash = Get-PathSha256 $Path "Publish journal"
    if ($null -eq $script:journalExpectedHash -or $diskHash -ne $script:journalExpectedHash) {
        throw "Immutable publish journal bytes changed and were preserved."
    }
    # The durable journal is an immutable write-ahead intent record. Physical
    # target/temp/backup hashes are the recovery state machine after a crash.
    # Later phases are kept only in memory so a process termination can never
    # tear the sole recovery record while the target is being replaced.
    $Record.phase = $Phase
    $Record.updatedUtc = [DateTime]::UtcNow.ToString("o")
    return $script:journalExpectedHash
}

function Read-JournalFile([string]$Path) {
    [void](Assert-RegularUnlinkedFile $Path "Publish journal")
    $stream = [System.IO.File]::Open(
        $Path,
        [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::Read,
        [System.IO.FileShare]::Read
    )
    try {
        return [pscustomobject]@{
            record = Read-JsonFromStream $stream "Publish journal"
            sha256 = Get-StreamSha256 $stream
        }
    }
    finally {
        $stream.Dispose()
    }
}

function Remove-ProvenFile(
    [string]$Path,
    [string]$ExpectedHash,
    [string]$TargetDirectory,
    [string]$Label
) {
    Assert-DirectChild $Path $TargetDirectory $Label
    if (-not (Test-EntryExists $Path)) {
        return
    }
    $actual = Get-PathSha256 $Path $Label
    if ($actual -ne $ExpectedHash) {
        throw "$Label changed before cleanup and was preserved."
    }
    [System.IO.File]::Delete($Path)
}

function Get-OptionalHash([string]$Path, [string]$Label) {
    if (-not (Test-EntryExists $Path)) {
        return $null
    }
    return Get-PathSha256 $Path $Label
}

function Pause-ForExternalCrashTest() {
    if ($InternalTestPauseAfterMutationMilliseconds -le 0) {
        return
    }
    if ($env:CODEX_XHS_PUBLISH_TEST_MODE -ne "1") {
        throw "The internal crash-test pause is disabled outside the test harness."
    }
    Start-Sleep -Milliseconds $InternalTestPauseAfterMutationMilliseconds
}

function Pause-ForMetadataCrashTest([string]$Phase) {
    if ($InternalTestPauseAfterMetadataPhase -ne $Phase -or $InternalTestPauseAfterMetadataMilliseconds -le 0) {
        return
    }
    if ($env:CODEX_XHS_PUBLISH_TEST_MODE -ne "1") {
        throw "The internal metadata crash-test pause is disabled outside the test harness."
    }
    Start-Sleep -Milliseconds $InternalTestPauseAfterMetadataMilliseconds
}

function Pause-ForTempCopyCrashTest() {
    if ($InternalTestPauseDuringTempCopyMilliseconds -le 0) {
        return
    }
    if ($env:CODEX_XHS_PUBLISH_TEST_MODE -ne "1") {
        throw "The internal temp-copy crash-test pause is disabled outside the test harness."
    }
    Start-Sleep -Milliseconds $InternalTestPauseDuringTempCopyMilliseconds
}

function New-AtomicJsonFile([string]$Path, [object]$Value, [string]$PausePhase) {
    Assert-EntryAbsent $Path "Publish metadata destination"
    $directory = [System.IO.Path]::GetDirectoryName([System.IO.Path]::GetFullPath($Path))
    $pending = "$Path.pending-$([System.Guid]::NewGuid().ToString("N"))"
    Assert-DirectChild $pending $directory "Publish metadata pending file"
    $stream = $null
    $expectedHash = $null
    try {
        $stream = [System.IO.File]::Open(
            $pending,
            [System.IO.FileMode]::CreateNew,
            [System.IO.FileAccess]::ReadWrite,
            [System.IO.FileShare]::None
        )
        $partialPhase = "$($PausePhase.Replace('_pending', ''))_partial"
        if ($InternalTestPauseAfterMetadataPhase -eq $partialPhase) {
            $partialBytes = [System.Text.Encoding]::ASCII.GetBytes("{")
            $stream.Write($partialBytes, 0, $partialBytes.Length)
            $stream.Flush($true)
            Pause-ForMetadataCrashTest $partialPhase
            $stream.Position = 0
            $stream.SetLength(0)
        }
        $expectedHash = Write-JsonToStream $stream $Value
        $stream.Dispose()
        $stream = $null
        Pause-ForMetadataCrashTest $PausePhase
        Assert-EntryAbsent $Path "Publish metadata destination"
        [System.IO.File]::Move($pending, $Path)
        if ((Get-PathSha256 $Path "Publish metadata") -ne $expectedHash) {
            throw "Atomically installed publish metadata changed after rename."
        }
        return $expectedHash
    }
    catch {
        if ($stream) {
            try { $stream.Dispose() } catch {}
        }
        if ($expectedHash -and (Test-EntryExists $pending)) {
            try { Remove-ProvenFile $pending $expectedHash $directory "Publish metadata pending file" } catch {}
        }
        throw
    }
}

function Open-BoundReadStream([string]$Path, [string]$Label) {
    $regularPath = Assert-RegularUnlinkedFile $Path $Label
    return [System.IO.File]::Open(
        $regularPath,
        [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::Read,
        [System.IO.FileShare]::Read
    )
}

function Copy-CandidateToTemp(
    [System.IO.FileStream]$CandidateStream,
    [string]$Temp,
    [string]$ExpectedCandidate,
    [string]$TargetDirectory
) {
    Assert-DirectChild $Temp $TargetDirectory "Publish temporary file"
    Assert-EntryAbsent $Temp "Publish temporary file"
    $CandidateStream.Position = 0
    $tempStream = [System.IO.File]::Open(
        $Temp,
        [System.IO.FileMode]::CreateNew,
        [System.IO.FileAccess]::Write,
        [System.IO.FileShare]::None
    )
    try {
        if ($InternalTestPauseDuringTempCopyMilliseconds -gt 0) {
            if ($env:CODEX_XHS_PUBLISH_TEST_MODE -ne "1") {
                throw "The internal temp-copy crash-test pause is disabled outside the test harness."
            }
            $prefix = New-Object byte[] 1
            $prefixLength = $CandidateStream.Read($prefix, 0, 1)
            if ($prefixLength -ne 1) {
                throw "Candidate must contain bytes before the internal temp-copy test pause."
            }
            $tempStream.Write($prefix, 0, $prefixLength)
            $tempStream.Flush($true)
            Pause-ForTempCopyCrashTest
        }
        $CandidateStream.CopyTo($tempStream)
        $tempStream.Flush($true)
    }
    finally {
        $tempStream.Dispose()
    }
    if ((Get-PathSha256 $Temp "Publish temporary file") -ne $ExpectedCandidate) {
        throw "Verified publish copy does not match the candidate SHA256."
    }
}

function Remove-OwnedDiscardFiles(
    [object]$Journal,
    [string]$TargetDirectory
) {
    $owner = [string]$Journal.owner
    $entries = @([System.IO.Directory]::EnumerateFileSystemEntries(
        $TargetDirectory,
        ".codex-xhs-discard-$owner-*.tmp",
        [System.IO.SearchOption]::TopDirectoryOnly
    ))
    foreach ($entry in $entries) {
        $discardPath = [System.IO.Path]::GetFullPath($entry)
        Assert-DirectChild $discardPath $TargetDirectory "Owned partial-temp discard"
        $name = [System.IO.Path]::GetFileName($discardPath)
        if ($name -notmatch "^\.codex-xhs-discard-$owner-([0-9a-fA-F]{64})\.tmp$") {
            throw "Malformed owned partial-temp discard was preserved: $discardPath"
        }
        $expectedDiscardHash = $Matches[1].ToUpperInvariant()
        Remove-ProvenFile $discardPath $expectedDiscardHash $TargetDirectory "Owned partial-temp discard"
    }
}

function Discard-OwnedPartialTemp(
    [object]$Journal,
    [string]$TargetDirectory,
    [string]$ObservedHash
) {
    $temp = [string]$Journal.tempPath
    Assert-DirectChild $temp $TargetDirectory "Owned partial publish file"
    $actualHash = Get-PathSha256 $temp "Owned partial publish file"
    if ($actualHash -ne $ObservedHash) {
        throw "Owned partial publish file changed before isolation and was preserved."
    }
    $discardPath = [System.IO.Path]::Combine(
        $TargetDirectory,
        ".codex-xhs-discard-$($Journal.owner)-$($ObservedHash.ToLowerInvariant()).tmp"
    )
    Assert-DirectChild $discardPath $TargetDirectory "Owned partial-temp discard"
    Assert-EntryAbsent $discardPath "Owned partial-temp discard"
    [System.IO.File]::Move($temp, $discardPath)
    $isolatedHash = Get-PathSha256 $discardPath "Owned partial-temp discard"
    if ($isolatedHash -ne $ObservedHash) {
        throw "Isolated partial publish bytes changed; the discard was preserved."
    }
    Remove-ProvenFile $discardPath $ObservedHash $TargetDirectory "Owned partial-temp discard"
}

function Complete-Or-RecoverTransaction(
    [object]$Journal,
    [string]$JournalPath,
    [string]$TargetDirectory,
    [ref]$JournalHash,
    [ref]$CandidateStream,
    [ref]$BaselineStream,
    [ref]$PublishedHash,
    [ref]$PublishStatus
) {
    $expectedBaseline = [string]$Journal.expectedBaselineSha256
    $expectedCandidate = [string]$Journal.expectedCandidateSha256
    $target = [string]$Journal.targetPath
    $baseline = [string]$Journal.baselinePath
    $candidate = [string]$Journal.candidatePath
    $temp = [string]$Journal.tempPath
    $backup = if ($null -eq $Journal.backupPath) { $null } else { [string]$Journal.backupPath }
    $targetExisted = [bool]$Journal.targetExisted

    $CandidateStream.Value = Open-BoundReadStream $candidate "Candidate file"
    if ((Get-StreamSha256 $CandidateStream.Value) -ne $expectedCandidate) {
        throw "Candidate SHA256 changed before publish or recovery."
    }

    if (-not $targetExisted) {
        $BaselineStream.Value = Open-BoundReadStream $baseline "Baseline file"
        if ((Get-StreamSha256 $BaselineStream.Value) -ne $expectedBaseline) {
            throw "Baseline SHA256 changed before first publish or recovery."
        }
    }

    $targetHash = Get-OptionalHash $target "Target file"
    $tempHash = Get-OptionalHash $temp "Publish temporary file"
    $backupHash = if ($null -eq $backup) { $null } else { Get-OptionalHash $backup "Publish backup file" }

    if ($targetExisted) {
        if ($expectedBaseline -eq $expectedCandidate -and $targetHash -eq $expectedCandidate -and $null -eq $tempHash -and $null -eq $backupHash) {
            $PublishStatus.Value = "already_current"
        }
        elseif ($targetHash -eq $expectedBaseline -and $null -eq $backupHash) {
            if ($Journal.phase -notin @("initial", "replace_armed")) {
                throw "Publish journal phase cannot authorize recovery from the initial replace state."
            }
            Remove-OwnedDiscardFiles $Journal $TargetDirectory
            if ($null -eq $tempHash) {
                if ($null -eq $BaselineStream.Value) {
                    $BaselineStream.Value = Open-BoundReadStream $baseline "Baseline file"
                }
                if ((Get-StreamSha256 $BaselineStream.Value) -ne $expectedBaseline) {
                    throw "Baseline SHA256 changed before recovered replace."
                }
                Copy-CandidateToTemp $CandidateStream.Value $temp $expectedCandidate $TargetDirectory
                $tempHash = $expectedCandidate
            }
            elseif ($tempHash -ne $expectedCandidate) {
                Discard-OwnedPartialTemp $Journal $TargetDirectory $tempHash
                Copy-CandidateToTemp $CandidateStream.Value $temp $expectedCandidate $TargetDirectory
                $tempHash = $expectedCandidate
            }

            $JournalHash.Value = Update-JournalFile $JournalPath $Journal "replace_armed"
            if ((Get-StreamSha256 $CandidateStream.Value) -ne $expectedCandidate) {
                throw "Candidate SHA256 changed immediately before replace."
            }
            if ((Get-PathSha256 $target "Target file") -ne $expectedBaseline) {
                throw "Target path SHA256 changed immediately before replace."
            }
            if ($BaselineStream.Value) {
                $BaselineStream.Value.Dispose()
                $BaselineStream.Value = $null
            }
            [System.IO.File]::Replace($temp, $target, $backup, $true)
            Pause-ForExternalCrashTest
            if ((Get-PathSha256 $backup "Publish backup file") -ne $expectedBaseline) {
                throw "Replaced target was not the bound baseline; concurrent external change detected."
            }
            $JournalHash.Value = Update-JournalFile $JournalPath $Journal "replace_committed"
            $targetHash = Get-PathSha256 $target "Target file"
            $tempHash = $null
            $backupHash = $expectedBaseline
            $PublishStatus.Value = "replaced"
        }
        elseif ($targetHash -eq $expectedCandidate -and $null -eq $tempHash) {
            if ($null -ne $backupHash -and $backupHash -ne $expectedBaseline) {
                throw "Publish backup hash is not the bound baseline; recovery is fail-closed."
            }
            if ($Journal.phase -in @("initial", "create_armed", "create_committed")) {
                throw "Target contains candidate bytes but the journal phase cannot prove a replace; recovery is fail-closed."
            }
            $PublishStatus.Value = if ($expectedBaseline -eq $expectedCandidate) { "already_current" } else { "replaced" }
        }
        else {
            throw "Target, temporary file, and backup do not form a provable replace state; all files were preserved."
        }
    }
    else {
        if ($null -eq $targetHash) {
            if ($Journal.phase -notin @("initial", "create_armed")) {
                throw "Publish journal phase cannot authorize recovery from the initial first-publish state."
            }
            Remove-OwnedDiscardFiles $Journal $TargetDirectory
            if ($null -eq $tempHash) {
                Copy-CandidateToTemp $CandidateStream.Value $temp $expectedCandidate $TargetDirectory
                $tempHash = $expectedCandidate
            }
            elseif ($tempHash -ne $expectedCandidate) {
                Discard-OwnedPartialTemp $Journal $TargetDirectory $tempHash
                Copy-CandidateToTemp $CandidateStream.Value $temp $expectedCandidate $TargetDirectory
                $tempHash = $expectedCandidate
            }
            $JournalHash.Value = Update-JournalFile $JournalPath $Journal "create_armed"
            if ((Get-StreamSha256 $BaselineStream.Value) -ne $expectedBaseline) {
                throw "Baseline SHA256 changed immediately before first publish."
            }
            if ((Get-StreamSha256 $CandidateStream.Value) -ne $expectedCandidate) {
                throw "Candidate SHA256 changed immediately before first publish."
            }
            Assert-EntryAbsent $target "Target path"
            [System.IO.File]::Move($temp, $target)
            Pause-ForExternalCrashTest
            $JournalHash.Value = Update-JournalFile $JournalPath $Journal "create_committed"
            $targetHash = Get-PathSha256 $target "Target file"
            $tempHash = $null
            $PublishStatus.Value = "created"
        }
        elseif ($targetHash -eq $expectedCandidate -and $null -eq $tempHash) {
            if ($Journal.phase -notin @("create_armed", "create_committed", "verified", "cleanup_complete")) {
                throw "Target contains candidate bytes but the journal phase cannot prove a first publish; recovery is fail-closed."
            }
            $PublishStatus.Value = "created"
        }
        else {
            throw "Target and temporary file do not form a provable first-publish state; all files were preserved."
        }
    }

    $PublishedHash.Value = Get-PathSha256 $target "Published target"
    if ($PublishedHash.Value -ne $expectedCandidate) {
        throw "Published target SHA256 does not match the candidate."
    }
    if ((Get-StreamSha256 $CandidateStream.Value) -ne $expectedCandidate) {
        throw "Candidate SHA256 changed during publish."
    }
    $JournalHash.Value = Update-JournalFile $JournalPath $Journal "verified"

    if ($null -ne $backup -and (Test-EntryExists $backup)) {
        Remove-ProvenFile $backup $expectedBaseline $TargetDirectory "Publish backup file"
    }
    if (Test-EntryExists $temp) {
        Remove-ProvenFile $temp $expectedCandidate $TargetDirectory "Publish temporary file"
    }
    $JournalHash.Value = Update-JournalFile $JournalPath $Journal "cleanup_complete"
}

function Rollback-Transaction(
    [object]$Journal,
    [string]$JournalPath,
    [string]$TargetDirectory,
    [ref]$JournalHash
) {
    $expectedBaseline = [string]$Journal.expectedBaselineSha256
    $expectedCandidate = [string]$Journal.expectedCandidateSha256
    $target = [string]$Journal.targetPath
    $temp = [string]$Journal.tempPath
    $backup = if ($null -eq $Journal.backupPath) { $null } else { [string]$Journal.backupPath }
    $targetHash = Get-OptionalHash $target "Target file"
    $tempHash = Get-OptionalHash $temp "Publish temporary file"
    $backupHash = if ($null -eq $backup) { $null } else { Get-OptionalHash $backup "Publish backup file" }

    if ([bool]$Journal.targetExisted) {
        if ($targetHash -eq $expectedCandidate -and $backupHash -eq $expectedBaseline -and $null -eq $tempHash) {
            $failed = [System.IO.Path]::Combine($TargetDirectory, ".codex-xhs-failed-$($Journal.owner).tmp")
            Assert-EntryAbsent $failed "Rollback displaced candidate"
            [System.IO.File]::Replace($backup, $target, $failed, $true)
            if ((Get-PathSha256 $target "Restored target") -ne $expectedBaseline) {
                throw "Rollback did not restore the bound baseline."
            }
            Remove-ProvenFile $failed $expectedCandidate $TargetDirectory "Rollback displaced candidate"
        }
        elseif ($targetHash -eq $expectedBaseline -and $null -eq $backupHash) {
            if ($Journal.phase -notin @("initial", "replace_armed")) {
                throw "Rollback journal phase cannot authorize cleanup from the initial replace state."
            }
            Remove-OwnedDiscardFiles $Journal $TargetDirectory
            if ($null -ne $tempHash) {
                if ($tempHash -ne $expectedCandidate) {
                    Discard-OwnedPartialTemp $Journal $TargetDirectory $tempHash
                }
                else {
                    Remove-ProvenFile $temp $expectedCandidate $TargetDirectory "Publish temporary file"
                }
            }
        }
        else {
            throw "Rollback state is not mechanically provable; target and recovery files were preserved."
        }
    }
    else {
        if ($targetHash -eq $expectedCandidate -and $null -eq $tempHash) {
            Remove-ProvenFile $target $expectedCandidate $TargetDirectory "Newly published target"
        }
        elseif ($null -eq $targetHash) {
            if ($Journal.phase -notin @("initial", "create_armed")) {
                throw "Rollback journal phase cannot authorize cleanup from the initial first-publish state."
            }
            Remove-OwnedDiscardFiles $Journal $TargetDirectory
            if ($null -ne $tempHash) {
                if ($tempHash -ne $expectedCandidate) {
                    Discard-OwnedPartialTemp $Journal $TargetDirectory $tempHash
                }
                else {
                    Remove-ProvenFile $temp $expectedCandidate $TargetDirectory "Publish temporary file"
                }
            }
        }
        else {
            throw "First-publish rollback state is not mechanically provable; files were preserved."
        }
    }
    $JournalHash.Value = Update-JournalFile $JournalPath $Journal "rolled_back"
}

function Remove-TerminalJournalWithoutLock(
    [string]$TargetDirectory,
    [string]$InvocationDigest,
    [string]$Baseline,
    [string]$Candidate,
    [string]$Target,
    [string]$ExpectedBaseline,
    [string]$ExpectedCandidate
) {
    $entries = @([System.IO.Directory]::EnumerateFileSystemEntries(
        $TargetDirectory,
        ".codex-xhs-publish-*.journal",
        [System.IO.SearchOption]::TopDirectoryOnly
    ))
    if ($entries.Count -eq 0) {
        return $null
    }
    if ($entries.Count -ne 1) {
        throw "Multiple orphan publish journals exist; all were preserved for inspection."
    }
    $journalPath = [System.IO.Path]::GetFullPath($entries[0])
    [void](Assert-RegularUnlinkedFile $journalPath "Orphan publish journal")
    $name = [System.IO.Path]::GetFileName($journalPath)
    if ($name -notmatch "^\.codex-xhs-publish-([0-9a-f]{32})\.journal$") {
        throw "An unrecognized orphan publish journal was preserved."
    }
    $owner = $Matches[1]
    $journalRead = Read-JournalFile $journalPath
    $syntheticLock = [pscustomobject]@{
        kind = $LockKind
        version = $ProtocolVersion
        owner = $owner
        pid = $journalRead.record.pid
        processStartUtcTicks = $journalRead.record.processStartUtcTicks
        createdUtc = $journalRead.record.updatedUtc
        invocationDigest = $InvocationDigest
        baselinePath = $Baseline
        candidatePath = $Candidate
        targetPath = $Target
        expectedBaselineSha256 = $ExpectedBaseline
        expectedCandidateSha256 = $ExpectedCandidate
        journalPath = $journalPath
    }
    Assert-JournalRecord $journalRead.record $syntheticLock $TargetDirectory
    if (Test-RecordedProcessAlive ([int]$journalRead.record.pid) ([long]$journalRead.record.processStartUtcTicks)) {
        throw "Orphan journal owner is still running; publication is fail-closed."
    }
    if ((Get-PathSha256 $Candidate "Candidate file") -ne $ExpectedCandidate) {
        throw "Candidate changed while cleaning an orphan journal; the journal was preserved."
    }
    $temp = [string]$journalRead.record.tempPath
    $backup = if ($null -eq $journalRead.record.backupPath) { $null } else { [string]$journalRead.record.backupPath }
    $targetHash = Get-OptionalHash $Target "Target file"
    $tempHash = Get-OptionalHash $temp "Publish temporary file"
    $backupHash = if ($null -eq $backup) { $null } else { Get-OptionalHash $backup "Publish backup file" }

    if ([bool]$journalRead.record.targetExisted) {
        if ($targetHash -eq $ExpectedCandidate -and $null -eq $tempHash -and
            ($null -eq $backupHash -or $backupHash -eq $ExpectedBaseline)) {
            if ($null -ne $backupHash) {
                Remove-ProvenFile $backup $ExpectedBaseline $TargetDirectory "Orphan publish backup"
            }
            Remove-ProvenFile $journalPath $journalRead.sha256 $TargetDirectory "Orphan publish journal"
            return "already_current"
        }
        if ($targetHash -eq $ExpectedBaseline -and $null -eq $backupHash -and
            ($null -eq $tempHash -or $tempHash -eq $ExpectedCandidate)) {
            if ($null -ne $tempHash) {
                Remove-ProvenFile $temp $ExpectedCandidate $TargetDirectory "Orphan publish temporary file"
            }
            Remove-ProvenFile $journalPath $journalRead.sha256 $TargetDirectory "Orphan publish journal"
            return "rolled_back"
        }
    }
    else {
        if ($targetHash -eq $ExpectedCandidate -and $null -eq $tempHash) {
            Remove-ProvenFile $journalPath $journalRead.sha256 $TargetDirectory "Orphan publish journal"
            return "already_current"
        }
        if ($null -eq $targetHash -and ($null -eq $tempHash -or $tempHash -eq $ExpectedCandidate)) {
            if ($null -ne $tempHash) {
                Remove-ProvenFile $temp $ExpectedCandidate $TargetDirectory "Orphan publish temporary file"
            }
            Remove-ProvenFile $journalPath $journalRead.sha256 $TargetDirectory "Orphan publish journal"
            return "rolled_back"
        }
    }
    throw "Orphan journal state is not mechanically provable; all files were preserved."
}

function Remove-MatchingOrphanLockPendings(
    [string]$LockPath,
    [string]$TargetDirectory,
    [string]$InvocationDigest,
    [string]$Baseline,
    [string]$Candidate,
    [string]$Target,
    [string]$ExpectedBaseline,
    [string]$ExpectedCandidate
) {
    $entries = @([System.IO.Directory]::EnumerateFileSystemEntries(
        $TargetDirectory,
        "$([System.IO.Path]::GetFileName($LockPath)).pending-*",
        [System.IO.SearchOption]::TopDirectoryOnly
    ))
    foreach ($entry in $entries) {
        $pending = [System.IO.Path]::GetFullPath($entry)
        try {
            [void](Assert-RegularUnlinkedFile $pending "Orphan lock pending file")
            $stream = [System.IO.File]::Open(
                $pending,
                [System.IO.FileMode]::Open,
                [System.IO.FileAccess]::Read,
                [System.IO.FileShare]::Read
            )
            try {
                $record = Read-JsonFromStream $stream "Orphan lock pending file"
                $pendingHash = Get-StreamSha256 $stream
            }
            finally {
                $stream.Dispose()
            }
            Assert-LockRecord `
                $record $InvocationDigest $Baseline $Candidate $Target $ExpectedBaseline $ExpectedCandidate $TargetDirectory
            if (Test-RecordedProcessAlive ([int]$record.pid) ([long]$record.processStartUtcTicks)) {
                continue
            }
            if ((Get-PathSha256 $Candidate "Candidate file") -ne $ExpectedCandidate) {
                throw "Candidate changed while checking an orphan lock pending file."
            }
            if (Test-EntryExists $Target) {
                if (-not (Test-SamePath $Baseline $Target) -or (Get-PathSha256 $Target "Target file") -ne $ExpectedBaseline) {
                    throw "Target changed after the lock pending file was staged."
                }
            }
            elseif ((Get-PathSha256 $Baseline "Baseline file") -ne $ExpectedBaseline) {
                throw "Baseline changed after the lock pending file was staged."
            }
            Remove-ProvenFile $pending $pendingHash $TargetDirectory "Orphan lock pending file"
        }
        catch {
            # An unrecognized or changed pending file is never deleted and cannot
            # authorize recovery. It is outside the canonical lock path, so the
            # target-scoped mutex still permits a new independent transaction.
        }
    }
}

$baselineStream = $null
$candidateStream = $null
$lockStream = $null
$mutex = $null
$mutexOwned = $false
$lockOwned = $false
$lockPath = $null
$lockExpectedHash = $null
$journalPath = $null
$journalExpectedHash = $null
$journal = $null
$target = $TargetPath
$publishedHash = $null
$publishStatus = $null
$publishedVerified = $false
$primaryError = $null
$rollbackError = $null
$preservedBackup = $null
$preservedTarget = $null
$cleanupErrors = New-Object System.Collections.Generic.List[string]

try {
    $baseline = [System.IO.Path]::GetFullPath($BaselinePath)
    $candidate = [System.IO.Path]::GetFullPath($CandidatePath)
    $target = [System.IO.Path]::GetFullPath($TargetPath)
    $expectedBaseline = Normalize-Hash $ExpectedBaselineSha256
    $expectedCandidate = Normalize-Hash $ExpectedCandidateSha256
    $targetDirectory = [System.IO.Path]::GetDirectoryName($target)

    if (-not [System.IO.Directory]::Exists($targetDirectory)) {
        throw "Target directory does not exist."
    }
    if ([System.IO.Path]::GetExtension($baseline).ToLowerInvariant() -ne ".xlsx" -or
        [System.IO.Path]::GetExtension($candidate).ToLowerInvariant() -ne ".xlsx" -or
        [System.IO.Path]::GetExtension($target).ToLowerInvariant() -ne ".xlsx") {
        throw "Baseline, candidate, and target paths must use the .xlsx extension."
    }
    Assert-DirectChild $baseline $targetDirectory "BaselinePath"
    if (Test-SamePath $candidate $target) {
        throw "Candidate and target paths must be different."
    }
    [void](Assert-RegularUnlinkedFile $baseline "Baseline file")
    [void](Assert-RegularUnlinkedFile $candidate "Candidate file")

    $invocationDigest = Get-InvocationDigest $baseline $candidate $target $expectedBaseline $expectedCandidate
    $mutexDigest = Get-TextSha256 ([System.IO.Path]::GetFullPath($target).ToLowerInvariant())
    $mutexName = "Local\CodexXhsPublish-$mutexDigest"
    $mutex = New-Object System.Threading.Mutex($false, $mutexName)
    try {
        $mutexOwned = $mutex.WaitOne(0)
    }
    catch [System.Threading.AbandonedMutexException] {
        $mutexOwned = $true
    }
    if (-not $mutexOwned) {
        throw "Could not acquire the target-scoped publish mutex. Another workflow is publishing."
    }

    $lockPath = [System.IO.Path]::Combine($targetDirectory, ".codex-xhs-publish.lock")
    Assert-DirectChild $lockPath $targetDirectory "Publish lock"

    if (-not (Test-EntryExists $lockPath)) {
        Remove-MatchingOrphanLockPendings `
            $lockPath $targetDirectory $invocationDigest $baseline $candidate $target $expectedBaseline $expectedCandidate
        $orphanStatus = Remove-TerminalJournalWithoutLock `
            $targetDirectory $invocationDigest $baseline $candidate $target $expectedBaseline $expectedCandidate
        if ($orphanStatus -eq "already_current") {
            $publishedHash = $expectedCandidate
            $publishStatus = "already_current"
            $publishedVerified = $true
        }
    }

    if ($RecoveryOnly -and -not $publishedVerified -and -not (Test-EntryExists $lockPath)) {
        $publishStatus = "no_recovery"
        $publishedHash = $null
        $publishedVerified = $true
    }

    if (-not $publishedVerified) {
        $recoveredLock = Test-EntryExists $lockPath
        if ($recoveredLock) {
            [void](Assert-RegularUnlinkedFile $lockPath "Publish lock")
            try {
                $lockStream = [System.IO.File]::Open(
                    $lockPath,
                    [System.IO.FileMode]::Open,
                    [System.IO.FileAccess]::ReadWrite,
                    [System.IO.FileShare]::None
                )
            }
            catch {
                throw "Could not acquire the same-directory publish lock. Another workflow may still be publishing. Lock: $lockPath"
            }
            $lockRecord = Read-JsonFromStream $lockStream "Publish lock"
            $lockExpectedHash = Get-StreamSha256 $lockStream
            Assert-LockRecord `
                $lockRecord $invocationDigest $baseline $candidate $target $expectedBaseline $expectedCandidate $targetDirectory
            if (Test-RecordedProcessAlive ([int]$lockRecord.pid) ([long]$lockRecord.processStartUtcTicks)) {
                throw "The publish lock owner is still running; recovery was not attempted."
            }
            $lockOwned = $true
            $journalPath = [string]$lockRecord.journalPath
            if (Test-EntryExists $journalPath) {
                $journalRead = Read-JournalFile $journalPath
                $journal = $journalRead.record
                $journalExpectedHash = $journalRead.sha256
                Assert-JournalRecord $journal $lockRecord $targetDirectory
            }
            else {
                $journalPendingEntries = @([System.IO.Directory]::EnumerateFileSystemEntries(
                    $targetDirectory,
                    "$([System.IO.Path]::GetFileName($journalPath)).pending-*",
                    [System.IO.SearchOption]::TopDirectoryOnly
                ))
                if ($journalPendingEntries.Count -eq 1) {
                    $journalPending = [System.IO.Path]::GetFullPath($journalPendingEntries[0])
                    try {
                        $pendingRead = Read-JournalFile $journalPending
                        Assert-JournalRecord $pendingRead.record $lockRecord $targetDirectory
                        Assert-EntryAbsent $journalPath "Recovered publish journal"
                        [System.IO.File]::Move($journalPending, $journalPath)
                        if ((Get-PathSha256 $journalPath "Recovered publish journal") -ne $pendingRead.sha256) {
                            throw "Recovered journal changed during atomic installation."
                        }
                        $journal = $pendingRead.record
                        $journalExpectedHash = $pendingRead.sha256
                    }
                    catch {
                        $journal = $null
                    }
                }
                if ($null -eq $journal -and $journalPendingEntries.Count -gt 0) {
                    $targetAtInitialState = Test-EntryExists $target
                    if ($targetAtInitialState) {
                        if (-not (Test-SamePath $baseline $target) -or
                            (Get-PathSha256 $target "Target file") -ne $expectedBaseline) {
                            throw "Invalid pending journal exists after target state changed; all metadata was preserved."
                        }
                    }
                    elseif ((Get-PathSha256 $baseline "Baseline file") -ne $expectedBaseline) {
                        throw "Invalid pending journal exists after baseline state changed; all metadata was preserved."
                    }
                    if ((Get-PathSha256 $candidate "Candidate file") -ne $expectedCandidate) {
                        throw "Invalid pending journal exists after candidate state changed; all metadata was preserved."
                    }
                    $ownedTemp = [System.IO.Path]::Combine($targetDirectory, ".codex-xhs-publish-$($lockRecord.owner).tmp")
                    $ownedBackup = [System.IO.Path]::Combine($targetDirectory, ".codex-xhs-backup-$($lockRecord.owner).tmp")
                    if ((Test-EntryExists $ownedTemp) -or (Test-EntryExists $ownedBackup)) {
                        throw "Invalid pending journal coexists with transaction data; recovery is fail-closed."
                    }
                    foreach ($pendingEntry in $journalPendingEntries) {
                        $pendingPath = [System.IO.Path]::GetFullPath($pendingEntry)
                        $pendingHash = Get-PathSha256 $pendingPath "Owned invalid journal pending file"
                        Remove-ProvenFile $pendingPath $pendingHash $targetDirectory "Owned invalid journal pending file"
                    }
                }
            }
            if ($null -eq $journal) {
                $targetExistsForRecovery = Test-EntryExists $target
                if ($targetExistsForRecovery) {
                    [void](Assert-RegularUnlinkedFile $target "Target file")
                }
                $targetExistedForRecovery = $targetExistsForRecovery
                if ($targetExistsForRecovery -and -not (Test-SamePath $baseline $target)) {
                    throw "Recovered lock has no journal and the target appeared externally; recovery is fail-closed."
                }
                if ($targetExistsForRecovery -and (Get-PathSha256 $target "Target file") -ne $expectedBaseline) {
                    throw "Recovered lock has no journal and target bytes changed; recovery is fail-closed."
                }
                if ((Get-PathSha256 $baseline "Baseline file") -ne $expectedBaseline -or
                    (Get-PathSha256 $candidate "Candidate file") -ne $expectedCandidate) {
                    throw "Recovered lock has no journal and bound inputs changed; recovery is fail-closed."
                }
                $temp = [System.IO.Path]::Combine($targetDirectory, ".codex-xhs-publish-$($lockRecord.owner).tmp")
                $backup = if ($targetExistedForRecovery) {
                    [System.IO.Path]::Combine($targetDirectory, ".codex-xhs-backup-$($lockRecord.owner).tmp")
                } else { $null }
                Assert-EntryAbsent $temp "Recovered publish temporary file"
                if ($null -ne $backup) { Assert-EntryAbsent $backup "Recovered publish backup file" }
                $armedPhase = if ($targetExistedForRecovery) { "replace_armed" } else { "create_armed" }
                $journal = New-JournalRecord $lockRecord $targetExistedForRecovery $temp $backup $armedPhase
                $journalExpectedHash = New-JournalFile $journalPath $journal
            }
        }
        else {
            $owner = [System.Guid]::NewGuid().ToString("N")
            $journalPath = [System.IO.Path]::Combine($targetDirectory, ".codex-xhs-publish-$owner.journal")
            $processStartTicks = Get-CurrentProcessStartTicks
            $lockRecord = New-LockRecord `
                $owner $PID $processStartTicks $invocationDigest $baseline $candidate $target `
                $expectedBaseline $expectedCandidate $journalPath
            $lockExpectedHash = New-AtomicJsonFile $lockPath $lockRecord "lock_pending"
            try {
                $lockStream = [System.IO.File]::Open(
                    $lockPath,
                    [System.IO.FileMode]::Open,
                    [System.IO.FileAccess]::ReadWrite,
                    [System.IO.FileShare]::None
                )
            }
            catch {
                throw "Could not open the atomically installed same-directory publish lock. Lock: $lockPath"
            }
            $lockOwned = $true
            if ((Get-StreamSha256 $lockStream) -ne $lockExpectedHash) {
                throw "Atomically installed publish lock changed before acquisition."
            }

            $targetExisted = Test-EntryExists $target
            if ($targetExisted) {
                [void](Assert-RegularUnlinkedFile $target "Target file")
                if (-not (Test-SamePath $baseline $target)) {
                    throw "When the target exists, BaselinePath must be the target path."
                }
            }
            $temp = [System.IO.Path]::Combine($targetDirectory, ".codex-xhs-publish-$owner.tmp")
            $backup = if ($targetExisted) {
                [System.IO.Path]::Combine($targetDirectory, ".codex-xhs-backup-$owner.tmp")
            } else { $null }
            Assert-EntryAbsent $journalPath "Publish journal"
            Assert-EntryAbsent $temp "Publish temporary file"
            if ($null -ne $backup) { Assert-EntryAbsent $backup "Publish backup file" }

            $baselineStream = Open-BoundReadStream $baseline "Baseline file"
            $candidateStream = Open-BoundReadStream $candidate "Candidate file"
            if ((Get-StreamSha256 $baselineStream) -ne $expectedBaseline) {
                throw "Baseline SHA256 changed before publish."
            }
            if ((Get-StreamSha256 $candidateStream) -ne $expectedCandidate) {
                throw "Candidate SHA256 changed before publish."
            }
            $armedPhase = if ($targetExisted) { "replace_armed" } else { "create_armed" }
            $journal = New-JournalRecord $lockRecord $targetExisted $temp $backup $armedPhase
            $journalExpectedHash = New-JournalFile $journalPath $journal
            $baselineStream.Dispose()
            $baselineStream = $null
            $candidateStream.Dispose()
            $candidateStream = $null
        }

        Complete-Or-RecoverTransaction `
            $journal $journalPath $targetDirectory ([ref]$journalExpectedHash) `
            ([ref]$candidateStream) ([ref]$baselineStream) ([ref]$publishedHash) ([ref]$publishStatus)
        $publishedVerified = $true
    }
}
catch {
    $primaryError = $_.Exception.Message
    if (-not $publishedVerified -and $null -ne $journal -and $null -ne $journalPath) {
        try {
            if ($candidateStream) {
                $candidateStream.Dispose()
                $candidateStream = $null
            }
            if ($baselineStream) {
                $baselineStream.Dispose()
                $baselineStream = $null
            }
            Rollback-Transaction $journal $journalPath $targetDirectory ([ref]$journalExpectedHash)
        }
        catch {
            $rollbackError = $_.Exception.Message
            if ($null -ne $journal.backupPath -and (Test-EntryExists ([string]$journal.backupPath))) {
                $preservedBackup = [string]$journal.backupPath
            }
            if (Test-EntryExists ([string]$journal.targetPath)) {
                $preservedTarget = [string]$journal.targetPath
            }
        }
    }
}
finally {
    if ($candidateStream) {
        try { $candidateStream.Dispose() } catch { $cleanupErrors.Add("candidate stream: " + $_.Exception.Message) }
    }
    if ($baselineStream) {
        try { $baselineStream.Dispose() } catch { $cleanupErrors.Add("baseline stream: " + $_.Exception.Message) }
    }

    $canReleaseTransaction = $null -eq $rollbackError -and $null -ne $journal -and $TerminalPhases -contains [string]$journal.phase
    if ($canReleaseTransaction -and $lockOwned -and $lockStream) {
        try {
            if ((Get-StreamSha256 $lockStream) -ne $lockExpectedHash) {
                throw "Publish lock bytes changed while exclusively held."
            }
            $lockStream.Dispose()
            $lockStream = $null
            Remove-ProvenFile $lockPath $lockExpectedHash $targetDirectory "Publish lock"
            $lockOwned = $false
        }
        catch {
            $cleanupErrors.Add("publish lock: " + $_.Exception.Message)
        }
        if (-not $lockOwned) {
            try {
                Remove-ProvenFile $journalPath $journalExpectedHash $targetDirectory "Publish journal"
                $journal = $null
            }
            catch {
                $cleanupErrors.Add("publish journal: " + $_.Exception.Message)
            }
        }
    }
    elseif ($null -eq $journal -and $lockOwned -and $lockStream) {
        try {
            if ((Get-StreamSha256 $lockStream) -ne $lockExpectedHash) {
                throw "Publish lock bytes changed while exclusively held."
            }
            $lockStream.Dispose()
            $lockStream = $null
            Remove-ProvenFile $lockPath $lockExpectedHash $targetDirectory "Publish lock"
            $lockOwned = $false
        }
        catch {
            $cleanupErrors.Add("publish lock: " + $_.Exception.Message)
        }
    }

    if ($lockStream) {
        try { $lockStream.Dispose() } catch { $cleanupErrors.Add("publish lock stream: " + $_.Exception.Message) }
    }
    if ($mutexOwned -and $mutex) {
        try { $mutex.ReleaseMutex() } catch { $cleanupErrors.Add("publish mutex: " + $_.Exception.Message) }
    }
    if ($mutex) {
        try { $mutex.Dispose() } catch { $cleanupErrors.Add("publish mutex handle: " + $_.Exception.Message) }
    }
}

$recoveryLock = if ($lockPath -and (Test-EntryExists $lockPath)) { $lockPath } else { $null }
$recoveryJournal = if ($journalPath -and (Test-EntryExists $journalPath)) { $journalPath } else { $null }

if ($primaryError) {
    $result = [pscustomobject]@{
        ok = $false
        status = "publish_failed"
        error = $primaryError
        rollback_error = $rollbackError
        preserved_backup = $preservedBackup
        preserved_target = $preservedTarget
        recovery_lock = $recoveryLock
        recovery_journal = $recoveryJournal
        cleanup_errors = $cleanupErrors.ToArray()
        target = $target
    }
    $exitCode = 1
}
elseif ($cleanupErrors.Count -gt 0) {
    $result = [pscustomobject]@{
        ok = $false
        status = "published_cleanup_failed"
        error = "The target was verified, but one or more exact owned transaction files could not be cleaned. Re-run with the same bound parameters."
        rollback_error = $null
        preserved_backup = $null
        preserved_target = $target
        recovery_lock = $recoveryLock
        recovery_journal = $recoveryJournal
        cleanup_errors = $cleanupErrors.ToArray()
        target = $target
        sha256 = $publishedHash
    }
    $exitCode = 1
}
else {
    $result = [pscustomobject]@{
        ok = $true
        status = $publishStatus
        target = $target
        sha256 = $publishedHash
    }
    $exitCode = 0
}

Write-Output (ConvertTo-AsciiJson $result)
exit $exitCode
