function processInput(ev)
{
	var ev = ev || window.event;
	var key = ev.which || ev.keyCode;
	var input = $("#input");
	var content = input.text();

	// ctrl + h
	if (ev.ctrlKey && key == 85) {
		input.html("");
		return true;
	}

    // ctrl + d
	if (ev.ctrlKey && key == 68) {
        $("#terminal").fadeOut("slow");
		return true;
	}

	// ctrl + l
	if (ev.ctrlKey && key == 76) {
		$(".output").remove();
		input.html("");
		return true;
	}

	// ctrl + p or UP
	if ((ev.ctrlKey && key == 80) || (key == 38)) {
        if (history_list.length > 0) {
            content = previous_command();
            input.html(content);
            return true;
        }
		return false;
	}

	// ctrl + n or DOWN
	if ((ev.ctrlKey && key == 78) || (key == 40)) {
        if (history_list.length > 0) {
            content = next_command();
            input.html(content);
            return true;
        }
		return false;
	}

	/* backspace */
	if (key == 8) {
		var len = content.length;
		content = content.slice(0, len - 1);
		input.html(content);
		return true;
	}

	/* enter */
	if (key == 13) {
		var lastLine = $("#lastLine");
        var cmd = content
		lastLine.before("<div class='output'>fgp@int32bit.sh:~$&nbsp;" + cmd + "</div>");
		lastLine.before("<div class='output'>" + execute(cmd) + "</div>");
		input.html("");
		/* 让滚动条到底部 */
		var inputBody = document.getElementById("terminal-input-body");
		inputBody.scrollTop = inputBody.scrollHeight;
		return true;
	}
	/* space */
	if (key == 32) {
		content = input.html(); // 必须用html，否则只会插入一个空格
		content += "&nbsp;";
		input.html(content);
		return true;
	}

	/* tab */
	if (key == 9) {
        var ac = auto_completion(content);
        if (ac !== "") {
            content = ac;
            input.html(content);
            return true;
        }
		return false;
	}
	var s = _keycode_dictionary[key];
	if (s.length > 1)
		return false;
	if (ev.shiftKey) {
		s = _keycode_shifted_keys[s] || s
	}
	content += s;
	input.html(content);
}

var commands = register_commands("do_");
window.history_list = [];
var current_command_index = -1;
/* 解析命令，注意对象调用的方法的两种方式，使用“.”方式不行，后面的变量会变成字面字符串 */
function execute(input) {
	input = input.trim();
	if (!input) {
		return "";
	}
	fields = input.split(/\s+/);
	cmd = fields[0];
    args = fields.slice(1);
    var output = undefined;
	if (cmd in commands) {
		if (typeof commands[cmd] == "function") {
			output = commands[cmd](args, input);
		} else {
			output = commands[cmd];
		}
	}
    if (output == undefined) {
        output = cmd + "&nbsp;command not found";
    }
    history_list.push(input); // append current command to history_list 
    current_command_index = -1; // reset current command index
    return output;
}

function previous_command()
{
    var len = history_list.length;
    if (len < 1)
        return "";
    if (current_command_index == -1) {
        current_command_index = len - 1;
        return history_list[current_command_index];
    }
    if (current_command_index >= 1) {
        current_command_index--;
    }
    return history_list[current_command_index];
}

function next_command()
{
    var len = history_list.length;
    if (len < 1) {
        return "";
    }
    if (current_command_index <= len - 2) {
        current_command_index++;
    }
    return history_list[current_command_index];
}

function auto_completion(prefix)
{
    var results = [];
    for (var cmd in commands) {
        if (cmd.startswith(prefix)) {
            results.push(cmd);
        }
    }
    if (results.length == 1) {
        return results[0];
    } else {
        return "";
    }
}

function register_commands(prefix)
{
    var prefix = prefix || "do_";
    var prefix_len = prefix.length;
    var keys = Object.keys(window).filter(function (e) {
        return e.startswith(prefix); // String.startswith() is a custom function, import util.js first.
    }); 
    var discovered_commands = {};
    for (var k in keys) {
        var key = keys[k];
        var stripped_key = key.slice(prefix_len);
        discovered_commands[stripped_key] = window[key];
    }
    return discovered_commands;
}
