' hidden.vbs — מריץ פקודה בלי חלון (ל-scheduled tasks של גיבוי/watchdog)
' שימוש: wscript hidden.vbs <exe> <arg1> <arg2> ...
Set sh = CreateObject("WScript.Shell")
cmd = ""
For i = 0 To WScript.Arguments.Count - 1
  cmd = cmd & """" & WScript.Arguments(i) & """ "
Next
exitCode = sh.Run(Trim(cmd), 0, True)
WScript.Quit exitCode
