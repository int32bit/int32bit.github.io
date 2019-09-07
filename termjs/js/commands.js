var all_posts = get_posts();
var weibo = "http://weibo.com/316378881";
var github = "https://github.com/int32bit";
var zhihu = "https://www.zhihu.com/people/int32bit";
var twitter = "https://twitter.com/int32bit";

function do_help(args)
{
    var help = "快捷键: <br/>";
    help += "&nbsp;".repeat(4) + "<span class='dir'>Ctrl + L</span>" + "&nbsp;".repeat(4) + "清空终端，相当于执行clear命令.</br/>";
    help += "&nbsp;".repeat(4) + "<span class='dir'>Ctrl + H</span>" + "&nbsp;".repeat(4) + "删除一个字符,相当于按回退键.</br/>";
    help += "&nbsp;".repeat(4) + "<span class='dir'>Ctrl + U</span>" + "&nbsp;".repeat(4) + "删除整行内容.</br/>";
    help += "&nbsp;".repeat(4) + "<span class='dir'>Ctrl + P</span>" + "&nbsp;".repeat(4) + "向前遍历执行过的命令.</br/>";
    help += "&nbsp;".repeat(4) + "<span class='dir'>Ctrl + N</span>" + "&nbsp;".repeat(4) + "向后遍历执行过的命令.</br/>";
    help += "&nbsp;".repeat(4) + "<span class='dir'>Ctrl + D</span>" + "&nbsp;".repeat(4) + "退出终端.</br/>";

    help += "支持的命令列表: <br/>";
    for (i in commands) {
        help += "<span class='dir'>" + i + "</span> ";
    }
    return help;
}

function do_pwd(args)
{
    return "<span class='dir'>/beijing/polex</span>";
}

function do_top(args)
{
    return do_ls(args, 10);
}

function do_ls(args, count)
{
    if ($.inArray("-l", args) != -1) {
        return do_ll(args);
    }
    var posts = all_posts;
    var output = "";
    var count = count || 100;
    for (var i in posts) {
        output += "<a href='" + posts[i].url + "' class='dir' target='blank'>" + posts[i].title + "</a><br/>";
        if (i >= count - 1)
            break;
    }
    return output;
}

function do_ll(args)
{
    var posts = all_posts;
    var output = "total " + posts.length + "<br/>";
    for (var i in posts) {
        var author = posts[i].author || "int32bit";
        var title = posts[i].title;
        var date = posts[i].date.slice(0, 10);
        var group = posts[i].group || "admin";
        var size = paddingLeft(posts[i].size, 5, "&nbsp;");
        var url = posts[i].url;
        output += "-rw-r--r-- ";
        output += size + " ";
        output += author + " ";
        output += group + " ";
        output += date + " ";
        output += "<a class='dir' target='blank' href='" + url + "' >" + posts[i].title + "</a> ";
        output += "<br/>";
    }
    return output;
}

function do_cd(args)
{
    return "";
}

function do_about(args)
{
    var output = "";
    output += "Author: int32bit<br/>";
    output += "License: " + wrap_url("/LICENSE", "Apache 2 license") + "<br/>";
    output += "Version: " + "1.0-beta" + "<br/>";
    output += "Last update: " + "2016-10-03" + "<br/>";
    output += "版权所有&copy;2016 int32bit. 保留所有权利。";
    return output;
}
function do_info(args)
{
    var output = "";
    output += "name: " + "int32bit" + "<br/>";
    output += "weibo: " + wrap_url(weibo) + "<br/>";
    output += "github: " + wrap_url(github) + "<br/>";
    output += "zhihu: " + wrap_url(zhihu) + "<br/>";
    output += "twitter: " + wrap_url(twitter) + "<br/>";
    output += "wechat: " + wrap_url("../img/wechat.png", "int32bit");
    return output;
}

function do_whoami(args)
{
    return do_about(args);
}

function do_date(args)
{
    return new Date();
}

function do_clear(args)
{
    $(".output").remove();
    return "";
}

function do_groups(args)
{
    var groups = ["Linux", "Openstack", "Docker", "Ceph", "K8s", "Spark"];
    var output = "";
    for (var i in groups) {
        output += "<span class='highlight'>" + groups[i] + "</span>&nbsp;&nbsp;";
    }
    return output;
}

function do_history(args)
{
    var h = ""
    for (var i in history_list) {
        h += "<div>" + i + "&nbsp;&nbsp;" + history_list[i] + "</div>";
    }
    return h;
}

function do_close(args)
{
    
    window.open('','_self').close();
    return "";
}

function do_echo(args, input)
{
    var input = input.slice("echo".length).trim(); // trim is self-defined function
    input = input.replace(/^"/, "").replace(/"$/, "");
    input = input.replace(/^'/, "").replace(/'$/, "");
    return input;
}

function do_index(args)
{
    window.location = "/";
    return "";
}

function do_back(args)
{
    history.go(-1);
    return "";
}

function do_eval(args)
{
    return eval(args.toString()) || "0";
}

function do_weibo(args)
{
    return open_url(weibo);
}

function do_github(args)
{
    return open_url(github);
}

function do_zhihu(args)
{
    return open_url(zhihu);
}

function do_twitter(args)
{
    return open_url(twitter);
}

function do_exit(args)
{
    $("#terminal").fadeOut("slow");
    return "";
}

function do_reload(args)
{
    top.location.reload();
    return "";
}

function do_reset(args)
{
    top.location.reload();
    return "";
}

function do_background(args)
{
    changeBackground();
    return "";
}

function do_bg(args)
{
    return do_background();
}

function do_phone(args)
{
    return "1304106****";
}

function do_dirs(args)
{
    var output = "";
    output += "<span class='exec'>a.out</span>&nbsp;&nbsp;&nbsp;&nbsp;<span class='const'>bg.png</span>&nbsp;&nbsp;&nbsp;&nbsp;";
    output += "<span class='dir'>css</span>&nbsp;&nbsp;&nbsp;&nbsp;<span class='nornal'>helloworld.c</span>&nbsp;&nbsp;&nbsp;&nbsp;";
    output += "<span class='nornal'>index.html</span>&nbsp;&nbsp;&nbsp;&nbsp;<span class='dir'>js</span>&nbsp;&nbsp;&nbsp;&nbsp;";
    return output;
}
